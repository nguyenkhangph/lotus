// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LotusJar} from "./LotusJar.sol";

/// @notice Deploys jars and remembers them, so the API can trust a SpendExecuted log
///         only when it comes from a jar this factory created.
contract LotusJarFactory {
    mapping(address => bool) public isJar;
    mapping(address => address[]) internal _jarsOf;

    event JarCreated(address indexed owner, address jar);

    function createJar(LotusJar.Config calldata c) external returns (address jar) {
        // Only the caller can be the owner: nobody can create a jar on someone else's behalf.
        LotusJar.Config memory cfg = c;
        cfg.owner = msg.sender;
        jar = address(new LotusJar(cfg));
        isJar[jar] = true;
        _jarsOf[msg.sender].push(jar);
        emit JarCreated(msg.sender, jar);
    }

    function jarsOf(address owner) external view returns (address[] memory) {
        return _jarsOf[owner];
    }
}
