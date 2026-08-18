// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  ERC-6551 Registry — canonical reference implementation (v0.3.1)
 *  ---------------------------------------------------------------------------
 *  Deterministically computes and deploys a token-bound account for any
 *  (implementation, salt, chainId, tokenContract, tokenId). This is the
 *  standard registry used across chains; deploy it once on Robinhood Chain.
 *
 *  Deploy this FIRST, then deploy OrlixAgentAccount (the implementation).
 *  Give both addresses to the ORLIX site to activate per-Agent wallets.
 * ---------------------------------------------------------------------------
 */

interface IERC6551Registry {
    event ERC6551AccountCreated(
        address account,
        address indexed implementation,
        bytes32 salt,
        uint256 chainId,
        address indexed tokenContract,
        uint256 indexed tokenId
    );

    error AccountCreationFailed();

    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}

contract ERC6551Registry is IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address) {
        assembly {
            // Memory Layout:
            // 0x00   0xff (1 byte) | registry (20) | salt (32) | bytecode hash (32)
            // 0x55   ERC-1167 header (20) | implementation (20) | ERC-1167 footer (15)
            //        | salt (32) | chainId (32) | tokenContract (32) | tokenId (32)
            pop(chainId)

            // Copy salt, chainId, tokenContract, tokenId from calldata
            calldatacopy(0x8c, 0x24, 0x80)

            // ERC-1167 footer, implementation, header
            mstore(0x6c, 0x5af43d82803e903d91602b57fd5bf3)
            mstore(0x5d, implementation)
            mstore(0x49, 0x3d60ad80600a3d3981f3363d3d373d3d3d363d73)

            // Create2 pre-image
            mstore8(0x00, 0xff)
            mstore(0x35, keccak256(0x55, 0xb7))
            mstore(0x01, shl(96, address()))
            mstore(0x15, salt)

            let computed := keccak256(0x00, 0x55)

            if iszero(extcodesize(computed)) {
                let deployed := create2(0, 0x55, 0xb7, salt)
                if iszero(deployed) {
                    mstore(0x00, 0x20188a59) // AccountCreationFailed()
                    revert(0x1c, 0x04)
                }
                mstore(0x6c, deployed)
                log4(
                    0x6c,
                    0x60,
                    0x79f19b3655ee38b1ce526556b7731a20c8f218fbda4a3990b6cc4172fdf88722,
                    implementation,
                    tokenContract,
                    tokenId
                )
                return(0x6c, 0x20)
            }

            mstore(0x00, shr(96, shl(96, computed)))
            return(0x00, 0x20)
        }
    }

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address) {
        assembly {
            pop(chainId)
            calldatacopy(0x8c, 0x24, 0x80)
            mstore(0x6c, 0x5af43d82803e903d91602b57fd5bf3)
            mstore(0x5d, implementation)
            mstore(0x49, 0x3d60ad80600a3d3981f3363d3d373d3d3d363d73)
            mstore8(0x00, 0xff)
            mstore(0x35, keccak256(0x55, 0xb7))
            mstore(0x01, shl(96, address()))
            mstore(0x15, salt)
            let computed := keccak256(0x00, 0x55)
            mstore(0x00, shr(96, shl(96, computed)))
            return(0x00, 0x20)
        }
    }
}
