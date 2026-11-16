// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LotusInbox — the invoice wallet ("ví hoá đơn")
/// @notice Receives payments (invoices, client transfers). It has no transfer function: the only way
///         tokens leave is `sweep`, which pays out by the owner's fixed split (e.g. 80% main wallet,
///         20% the agent's spending jar). Anyone may call `sweep`, so no bot needs a key here, and
///         nobody, the agent included, can send inbox funds anywhere the owner did not list.
contract LotusInbox {
    using SafeERC20 for IERC20;

    struct Share {
        address to;
        uint16 bps; // out of 10_000
        bytes32 label; // e.g. "MAIN", "JAR", "TAX"
    }

    uint256 public constant MAX_SHARES = 5;
    address public immutable owner;
    Share[] internal _shares;

    event SplitSet(Share[] shares);
    event Paid(address indexed token, address indexed to, uint256 amount, bytes32 label);
    event Swept(address indexed token, uint256 total, address indexed by);

    error NotOwner();
    error BadSplit();
    error NothingToSweep();

    constructor(address owner_, Share[] memory shares_) {
        if (owner_ == address(0)) revert NotOwner();
        owner = owner_;
        _setSplit(shares_);
    }

    /// @notice Only the owner (main wallet) changes where invoice money goes.
    function setSplit(Share[] calldata shares_) external {
        if (msg.sender != owner) revert NotOwner();
        _setSplit(shares_);
    }

    function shares() external view returns (Share[] memory) {
        return _shares;
    }

    /// @notice Pays out the whole balance of `token` by the split. The last share gets the rounding remainder.
    function sweep(address token) external returns (uint256 total) {
        total = IERC20(token).balanceOf(address(this));
        if (total == 0) revert NothingToSweep();
        uint256 left = total;
        uint256 n = _shares.length;
        for (uint256 i = 0; i < n; i++) {
            Share memory s = _shares[i];
            uint256 amount = i == n - 1 ? left : (total * s.bps) / 10_000;
            left -= amount;
            if (amount > 0) {
                IERC20(token).safeTransfer(s.to, amount);
                emit Paid(token, s.to, amount, s.label);
            }
        }
        emit Swept(token, total, msg.sender);
    }

    function _setSplit(Share[] memory s) internal {
        if (s.length == 0 || s.length > MAX_SHARES) revert BadSplit();
        delete _shares;
        uint256 sum;
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i].to == address(0) || s[i].bps == 0) revert BadSplit();
            sum += s[i].bps;
            _shares.push(s[i]);
        }
        if (sum != 10_000) revert BadSplit();
        emit SplitSet(s);
    }
}
