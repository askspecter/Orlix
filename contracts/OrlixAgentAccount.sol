// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  OrlixAgentAccount — ERC-6551 token-bound account implementation
 *  ---------------------------------------------------------------------------
 *  The on-chain wallet that every ORLIX Agent NFT gets. It is owned by whoever
 *  owns the Agent — transfer the NFT and the wallet (and everything in it)
 *  goes with it. It can receive ETH & any tokens, and the current Agent owner
 *  can make it execute arbitrary calls (send tokens, interact with dapps).
 *
 *  Self-contained (no imports). Deploy this AFTER ERC6551Registry, then give
 *  both addresses to the ORLIX site to activate Agent Wallets.
 *
 *  ⚠️  UNAUDITED. Test before holding meaningful value.
 * ---------------------------------------------------------------------------
 */

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract OrlixAgentAccount {
    uint256 public state; // increments on every execute — nonce/replay guard

    receive() external payable {}

    /// @notice Execute a call from this account. Only the current Agent owner may call.
    /// @param to      target address
    /// @param value   ETH to send
    /// @param data    calldata
    /// @param operation must be 0 (CALL); other operations are not supported
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory result)
    {
        require(_isValidSigner(msg.sender), "not token owner");
        require(operation == 0, "only call");
        ++state;
        bool success;
        (success, result) = to.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @notice ERC-6551: is `signer` allowed to act for this account right now?
    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        if (_isValidSigner(signer)) return 0x523e3260; // IERC6551Account.isValidSigner.selector
        return bytes4(0);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x6faff5f1 // IERC6551Account
            || interfaceId == 0x01ffc9a7; // IERC165
    }

    /// @notice The (chainId, tokenContract, tokenId) this account is bound to.
    ///         Read from the ERC-6551 footer appended to the account bytecode.
    function token() public view returns (uint256 chainId, address tokenContract, uint256 tokenId) {
        bytes memory footer = new bytes(0x60);
        assembly {
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// @notice Current owner of this account = current owner of the bound Agent NFT.
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        return IERC721(tokenContract).ownerOf(tokenId);
    }

    function _isValidSigner(address signer) internal view returns (bool) {
        return signer == owner();
    }
}
