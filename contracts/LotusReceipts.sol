// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice On-chain anchor for the off-chain hash-chained receipt ledger.
///         Only hashes go on-chain — never claim text, names or source content.
contract LotusReceipts {
    address public immutable operator;
    bytes32 public head;     // latest receipt hash
    uint256 public count;

    event ReceiptAnchored(uint256 indexed index, bytes32 indexed receiptHash, bytes32 prevHash, bytes32 evidencePackHash, bytes32 reasonCode);

    error NotOperator();
    error BrokenChain(bytes32 expectedPrev, bytes32 gotPrev);

    constructor(address operator_) {
        operator = operator_;
    }

    function anchor(bytes32 receiptHash, bytes32 prevHash, bytes32 evidencePackHash, bytes32 reasonCode) external {
        if (msg.sender != operator) revert NotOperator();
        if (prevHash != head) revert BrokenChain(head, prevHash);
        head = receiptHash;
        emit ReceiptAnchored(count, receiptHash, prevHash, evidencePackHash, reasonCode);
        count += 1;
    }
}
