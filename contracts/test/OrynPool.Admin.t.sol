// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OrynPool} from "../OrynPool.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolAdminTest is OrynPoolTestBase {
    // ---------------------------------------------------------------- constructor
    function test_Constructor_State() public view {
        assertEq(pool.owner(), owner);
        assertEq(pool.USDC(), address(usdc));
        assertEq(pool.EURC(), address(eurc));
        assertEq(pool.eurUsdPrice(), PRICE);
        assertEq(pool.eurcUsdPrice(), PRICE);
        assertEq(pool.priceUpdatedAt(), START);
        assertEq(pool.maxPriceAge(), 7 days);
        assertTrue(pool.isPriceFresh());
        assertEq(pool.priceOf(address(usdc)), 1e8);
        assertEq(pool.priceOf(address(eurc)), PRICE);

        OrynPool.ReserveData memory u = pool.getReserveData(address(usdc));
        assertEq(u.ltv, 8_000);
        assertEq(u.liquidationThreshold, 8_500);
        assertEq(u.liquidationBonus, 500);
        OrynPool.ReserveData memory e = pool.getReserveData(address(eurc));
        assertEq(e.ltv, 7_500);
        assertEq(e.liquidationThreshold, 8_000);
        assertEq(e.liquidationBonus, 500);
    }

    function test_Constructor_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new OrynPool(address(0), address(usdc), address(eurc), PRICE);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        new OrynPool(owner, address(0), address(eurc), PRICE);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        new OrynPool(owner, address(usdc), address(0), PRICE);
        vm.expectRevert(OrynPool.IdenticalAssets.selector);
        new OrynPool(owner, address(usdc), address(usdc), PRICE);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        new OrynPool(owner, address(usdc), address(eurc), 49_999_999);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        new OrynPool(owner, address(usdc), address(eurc), 200_000_001);
    }

    // ---------------------------------------------------------------- access control
    function test_OnlyOwner_AllAdminFunctionsRevertForOthers() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        pool.setRiskParams(address(usdc), 8_000, 8_500, 500, 0, 0);
        vm.expectRevert(err);
        pool.setEurcPrice(PRICE);
        vm.expectRevert(err);
        pool.setEurUsdPrice(PRICE);
        vm.expectRevert(err);
        pool.setMaxPriceAge(1 days);
        vm.expectRevert(err);
        pool.collectReserves(address(usdc), alice, 1);
        vm.expectRevert(err);
        pool.pause();
        vm.expectRevert(err);
        pool.unpause();
        vm.expectRevert(err);
        pool.rescueToken(address(0xBEEF), alice, 1);
        vm.expectRevert(err);
        pool.transferOwnership(alice);
        vm.stopPrank();
    }

    function test_SetRiskParams_OwnerUpdatesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit OrynPool.ParamsUpdated(address(usdc), 7_000, 8_000, 700, 5_000 * M, 4_000 * M);
        vm.prank(owner);
        pool.setRiskParams(address(usdc), 7_000, 8_000, 700, 5_000 * M, 4_000 * M);
        OrynPool.ReserveData memory d = pool.getReserveData(address(usdc));
        assertEq(d.ltv, 7_000);
        assertEq(d.liquidationThreshold, 8_000);
        assertEq(d.liquidationBonus, 700);
        assertEq(d.supplyCap, 5_000 * M);
        assertEq(d.borrowCap, 4_000 * M);
    }

    function test_SetRiskParams_Reverts() public {
        vm.startPrank(owner);
        vm.expectRevert(OrynPool.InvalidRiskParams.selector); // ltv >= threshold
        pool.setRiskParams(address(usdc), 8_500, 8_500, 500, 0, 0);
        vm.expectRevert(OrynPool.InvalidRiskParams.selector); // threshold > 95%
        pool.setRiskParams(address(usdc), 8_000, 9_501, 500, 0, 0);
        vm.expectRevert(OrynPool.InvalidRiskParams.selector); // bonus > 10%
        pool.setRiskParams(address(usdc), 8_000, 8_500, 1_001, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0xBEEF)));
        pool.setRiskParams(address(0xBEEF), 8_000, 8_500, 500, 0, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- two-step ownership
    function test_Ownership_TwoStepTransfer() public {
        vm.expectEmit(true, true, false, false, address(pool));
        emit Ownable2Step.OwnershipTransferStarted(owner, bob);
        vm.prank(owner);
        pool.transferOwnership(bob);
        assertEq(pool.owner(), owner);
        assertEq(pool.pendingOwner(), bob);

        // pending owner has no powers yet; current owner still does
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        pool.pause();
        vm.prank(owner);
        pool.pause();

        vm.expectEmit(true, true, false, false, address(pool));
        emit Ownable.OwnershipTransferred(owner, bob);
        vm.prank(bob);
        pool.acceptOwnership();
        assertEq(pool.owner(), bob);
        assertEq(pool.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        pool.unpause();
        vm.prank(bob);
        pool.unpause();
        assertFalse(pool.paused());
    }

    function test_Ownership_AcceptByNonPendingReverts() public {
        vm.prank(owner);
        pool.transferOwnership(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.acceptOwnership();
        assertEq(pool.owner(), owner);
    }

    function test_Ownership_AcceptWithoutPendingReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        pool.acceptOwnership();
    }

    function test_Ownership_TransferToZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.transferOwnership(address(0));
    }

    function test_Ownership_RenounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(OrynPool.OwnershipRenunciationDisabled.selector);
        pool.renounceOwnership();
        assertEq(pool.owner(), owner);
    }

    // ---------------------------------------------------------------- pause
    function test_Pause_BlocksBorrow_AllowsDepositRepayAndDebtFreeWithdraw() public {
        _bobPosition(100 * M);
        _deposit(carol, usdc, 100 * M); // debt-free depositor

        vm.expectEmit(false, false, false, true, address(pool));
        emit Pausable.Paused(owner);
        vm.prank(owner);
        pool.pause();
        assertTrue(pool.paused());

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.borrow(address(eurc), 1 * M);

        // deposit, repay and debt-free withdraw all still work
        _deposit(alice, usdc, 50 * M);
        _repay(bob, eurc, 40 * M);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 60 * M);
        _withdraw(carol, usdc, 100 * M);
        assertEq(pool.supplyBalanceOf(address(usdc), carol), 0);

        // debt-bearing withdraw is blocked
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.withdraw(address(usdc), 1 * M);
        assertEq(pool.maxBorrowable(address(eurc), bob), 0);

        vm.prank(owner);
        pool.unpause();
        _borrow(bob, eurc, 1 * M);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 61 * M);
    }

    function test_Pause_DoubleAndUnpauseWhenNotPausedRevert() public {
        vm.startPrank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        pool.unpause();
        pool.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.pause();
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- maxPriceAge
    function test_SetMaxPriceAge_BoundsAndEffect() public {
        vm.startPrank(owner);
        vm.expectRevert(OrynPool.InvalidMaxPriceAge.selector);
        pool.setMaxPriceAge(1 hours - 1);
        vm.expectRevert(OrynPool.InvalidMaxPriceAge.selector);
        pool.setMaxPriceAge(7 days + 1);
        vm.expectEmit(false, false, false, true, address(pool));
        emit OrynPool.MaxPriceAgeUpdated(1 hours);
        pool.setMaxPriceAge(1 hours);
        vm.stopPrank();
        assertEq(pool.maxPriceAge(), 1 hours);

        skip(1 hours);
        assertTrue(pool.isPriceFresh());
        skip(1);
        assertFalse(pool.isPriceFresh());
    }

    // ---------------------------------------------------------------- rescueToken
    function test_RescueToken_UnrelatedTokenOnly() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(pool), 100e18);
        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.UnrelatedTokenRescued(address(other), alice, 60e18);
        vm.prank(owner);
        pool.rescueToken(address(other), alice, 60e18);
        assertEq(other.balanceOf(alice), 60e18);
        assertEq(other.balanceOf(address(pool)), 40e18);
    }

    function test_RescueToken_Reverts() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.startPrank(owner);
        vm.expectRevert(OrynPool.InvalidRecipient.selector);
        pool.rescueToken(address(usdc), alice, 1);
        vm.expectRevert(OrynPool.InvalidRecipient.selector);
        pool.rescueToken(address(eurc), alice, 1);
        vm.expectRevert(OrynPool.InvalidRecipient.selector);
        pool.rescueToken(address(other), address(pool), 1);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.rescueToken(address(0), alice, 1);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.rescueToken(address(other), address(0), 1);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.rescueToken(address(other), alice, 0);
        vm.stopPrank();
    }
}
