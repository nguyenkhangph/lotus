// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title LotusJar — a policy-guarded spending jar ("hũ") for evidence payments.
/// @notice The jar holds test USDC on Avalanche Fuji. Money only leaves the jar when
///         the owner (or an approver key the owner chose, e.g. a Telegram bot) signs a
///         specific spend: token, payTo, amount, request hash, nonce and expiry.
///         The LLM agent never holds any of these keys; it can only relay signed spends.
///         Every check fails closed: a spend that breaks any rule reverts, never partially fills.
contract LotusJar is EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Spend {
        address token;       // matched by address, never by symbol
        address payTo;       // must be whitelisted
        uint256 amount;      // token base units
        bytes32 requestHash; // binds the payment to one exact request body + route
        uint256 nonce;       // one-time
        uint64 validBefore;  // signature expiry (unix seconds)
    }

    enum Status { None, Pending, Executed, Cancelled }

    struct Pending {
        Spend spend;
        uint64 executeAfter;
        uint32 day;
        Status status;
    }

    struct Caps {
        uint256 perTx;
        uint256 perDay;
        uint256 lifetime;
    }

    bytes32 public constant SPEND_TYPEHASH = keccak256(
        "Spend(address token,address payTo,uint256 amount,bytes32 requestHash,uint256 nonce,uint64 validBefore)"
    );

    // ------------------------------------------------------------------ state

    address public immutable owner;
    address public approver; // optional second signer (bot); same caps apply
    address public guardian; // may cancel and lock only; can never spend or unlock

    Caps public caps;
    uint64 public expiresAt;      // jar stops accepting spends after this
    uint64 public delay;          // cancel window in seconds (0 = execute immediately)
    uint32 public burstWindow;    // seconds
    uint32 public burstMax;       // max requests per window before auto-lock (0 = off)

    bool public locked;

    uint32 public currentDay;
    uint256 public spentToday;    // includes pending (reserved) amounts
    uint256 public spentLifetime; // includes pending (reserved) amounts

    uint64 public windowStart;
    uint32 public windowCount;

    mapping(address => bool) public tokenAllowed;
    mapping(address => bool) public payToAllowed;
    mapping(uint256 => bool) public nonceUsed;
    mapping(bytes32 => Pending) internal _pending;

    // ------------------------------------------------------------------ events

    event SpendRequested(
        bytes32 indexed id, address indexed token, address indexed payTo,
        uint256 amount, bytes32 requestHash, uint256 nonce, address signer, uint64 executeAfter
    );
    event SpendExecuted(bytes32 indexed id, address indexed token, address indexed payTo, uint256 amount, bytes32 requestHash);
    event SpendCancelled(bytes32 indexed id, address by);
    event Locked(address by, bytes32 reason);
    event Unlocked();
    event TokenSet(address token, bool allowed);
    event PayToSet(address payTo, bool allowed);
    event CapsSet(uint256 perTx, uint256 perDay, uint256 lifetime);
    event RolesSet(address approver, address guardian);
    event TimingSet(uint64 delay, uint64 expiresAt, uint32 burstWindow, uint32 burstMax);

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error NotOwnerOrGuardian();
    error JarLocked();
    error JarExpired();
    error SignatureExpired();
    error BadSigner();
    error NonceAlreadyUsed();
    error TokenNotAllowed();
    error PayToNotAllowed();
    error ZeroAmount();
    error PerTxCapExceeded();
    error DailyCapExceeded();
    error LifetimeCapExceeded();
    error NotPending();
    error TooEarly();

    // ------------------------------------------------------------------ setup

    struct Config {
        address owner;
        address approver;
        address guardian;
        address[] tokens;
        address[] payTos;
        Caps caps;
        uint64 expiresAt;
        uint64 delay;
        uint32 burstWindow;
        uint32 burstMax;
    }

    constructor(Config memory c) EIP712("LotusJar", "1") {
        owner = c.owner;
        approver = c.approver;
        guardian = c.guardian;
        caps = c.caps;
        expiresAt = c.expiresAt;
        delay = c.delay;
        burstWindow = c.burstWindow;
        burstMax = c.burstMax;
        for (uint256 i; i < c.tokens.length; ++i) {
            tokenAllowed[c.tokens[i]] = true;
            emit TokenSet(c.tokens[i], true);
        }
        for (uint256 i; i < c.payTos.length; ++i) {
            payToAllowed[c.payTos[i]] = true;
            emit PayToSet(c.payTos[i], true);
        }
        emit RolesSet(c.approver, c.guardian);
        emit CapsSet(c.caps.perTx, c.caps.perDay, c.caps.lifetime);
        emit TimingSet(c.delay, c.expiresAt, c.burstWindow, c.burstMax);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian();
        _;
    }

    // ------------------------------------------------------------------ spending

    /// @notice Anyone may relay a spend, but it must carry a valid owner/approver signature.
    /// @return id the pending spend id (also used when executed immediately)
    function request(Spend calldata s, bytes calldata signature) external returns (bytes32 id) {
        if (locked) revert JarLocked();
        if (block.timestamp > expiresAt) revert JarExpired();
        if (block.timestamp > s.validBefore) revert SignatureExpired();

        address signer = ECDSA.recover(_hashTypedDataV4(_structHash(s)), signature);
        if (signer != owner && (approver == address(0) || signer != approver)) revert BadSigner();

        if (nonceUsed[s.nonce]) revert NonceAlreadyUsed();
        if (!tokenAllowed[s.token]) revert TokenNotAllowed();
        if (!payToAllowed[s.payTo]) revert PayToNotAllowed();
        if (s.amount == 0) revert ZeroAmount();
        if (s.amount > caps.perTx) revert PerTxCapExceeded();

        _rollDay();
        if (spentToday + s.amount > caps.perDay) revert DailyCapExceeded();
        if (spentLifetime + s.amount > caps.lifetime) revert LifetimeCapExceeded();

        // Burst guard: too many requests in a short window locks the jar instead of paying.
        if (_burstTripped()) {
            locked = true;
            emit Locked(address(this), "BURST");
            return bytes32(0);
        }

        nonceUsed[s.nonce] = true;
        spentToday += s.amount;
        spentLifetime += s.amount;

        id = keccak256(abi.encode(address(this), s.nonce));
        uint64 executeAfter = uint64(block.timestamp) + delay;
        _pending[id] = Pending({spend: s, executeAfter: executeAfter, day: currentDay, status: Status.Pending});
        emit SpendRequested(id, s.token, s.payTo, s.amount, s.requestHash, s.nonce, signer, executeAfter);

        if (delay == 0) _execute(id);
    }

    /// @notice Executes a queued spend once its cancel window has passed.
    function execute(bytes32 id) external {
        Pending storage p = _pending[id];
        if (p.status != Status.Pending) revert NotPending();
        if (block.timestamp < p.executeAfter) revert TooEarly();
        _execute(id);
    }

    /// @notice Owner or guardian (Telegram/Zalo bot) cancels a queued spend inside the window.
    function cancel(bytes32 id) external onlyOwnerOrGuardian {
        Pending storage p = _pending[id];
        if (p.status != Status.Pending) revert NotPending();
        p.status = Status.Cancelled;
        if (p.day == currentDay) spentToday -= p.spend.amount;
        spentLifetime -= p.spend.amount;
        emit SpendCancelled(id, msg.sender);
    }

    function _execute(bytes32 id) internal {
        Pending storage p = _pending[id];
        if (locked) revert JarLocked();
        // Whitelists are re-checked at execution: the owner may have removed an entry meanwhile.
        if (!tokenAllowed[p.spend.token]) revert TokenNotAllowed();
        if (!payToAllowed[p.spend.payTo]) revert PayToNotAllowed();
        p.status = Status.Executed;
        IERC20(p.spend.token).safeTransfer(p.spend.payTo, p.spend.amount);
        emit SpendExecuted(id, p.spend.token, p.spend.payTo, p.spend.amount, p.spend.requestHash);
    }

    // ------------------------------------------------------------------ kill switch

    function lock(bytes32 reason) external onlyOwnerOrGuardian {
        locked = true;
        emit Locked(msg.sender, reason);
    }

    function unlock() external onlyOwner {
        locked = false;
        windowCount = 0;
        windowStart = uint64(block.timestamp);
        emit Unlocked();
    }

    // ------------------------------------------------------------------ owner config

    function setToken(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenSet(token, allowed);
    }

    function setPayTo(address payTo, bool allowed) external onlyOwner {
        payToAllowed[payTo] = allowed;
        emit PayToSet(payTo, allowed);
    }

    function setCaps(Caps calldata c) external onlyOwner {
        caps = c;
        emit CapsSet(c.perTx, c.perDay, c.lifetime);
    }

    function setRoles(address approver_, address guardian_) external onlyOwner {
        approver = approver_;
        guardian = guardian_;
        emit RolesSet(approver_, guardian_);
    }

    function setTiming(uint64 delay_, uint64 expiresAt_, uint32 burstWindow_, uint32 burstMax_) external onlyOwner {
        delay = delay_;
        expiresAt = expiresAt_;
        burstWindow = burstWindow_;
        burstMax = burstMax_;
        emit TimingSet(delay_, expiresAt_, burstWindow_, burstMax_);
    }

    /// @notice The owner can always take funds back, even when locked.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ views

    function getPending(bytes32 id) external view returns (Pending memory) {
        return _pending[id];
    }

    function hashSpend(Spend calldata s) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(s));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function remainingToday() external view returns (uint256) {
        uint32 day = uint32(block.timestamp / 1 days);
        uint256 used = day == currentDay ? spentToday : 0;
        return used >= caps.perDay ? 0 : caps.perDay - used;
    }

    // ------------------------------------------------------------------ internals

    function _structHash(Spend calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(SPEND_TYPEHASH, s.token, s.payTo, s.amount, s.requestHash, s.nonce, s.validBefore));
    }

    function _rollDay() internal {
        uint32 day = uint32(block.timestamp / 1 days);
        if (day != currentDay) {
            currentDay = day;
            spentToday = 0;
        }
    }

    function _burstTripped() internal returns (bool) {
        if (burstMax == 0) return false;
        if (block.timestamp > windowStart + burstWindow) {
            windowStart = uint64(block.timestamp);
            windowCount = 0;
        }
        windowCount += 1;
        return windowCount > burstMax;
    }
}
