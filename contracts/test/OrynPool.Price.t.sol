// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolPriceTest is OrynPoolTestBase {
    // ---------------------------------------------------------------- setEurcPrice
    function test_SetEurcPrice_StepUpAndDownExactly10Percent() public {
        uint256 up = PRICE + PRICE / 10; // +10% exactly
        vm.expectEmit(false, false, false, true, address(pool));
        emit OrynPool.PriceUpdated(up, block.timestamp);
        _setPrice(up);
        assertEq(pool.eurUsdPrice(), up);
        assertEq(pool.eurcUsdPrice(), up);
        assertEq(pool.priceUpdatedAt(), block.timestamp);
        assertEq(pool.priceOf(address(eurc)), up);

        uint256 down = up - up / 10;
        _setPrice(down);
        assertEq(pool.eurUsdPrice(), down);
    }

    function test_SetEurcPrice_StepTooLargeReverts() public {
        vm.startPrank(owner);
        vm.expectRevert(OrynPool.PriceStepTooLarge.selector);
        pool.setEurcPrice(PRICE + PRICE / 10 + 1);
        vm.expectRevert(OrynPool.PriceStepTooLarge.selector);
        pool.setEurcPrice(PRICE - PRICE / 10 - 1);
        vm.expectRevert(OrynPool.PriceStepTooLarge.selector);
        pool.setEurcPrice(130_000_000);
        vm.expectRevert(OrynPool.PriceStepTooLarge.selector);
        pool.setEurcPrice(0);
        vm.stopPrank();
        assertEq(pool.eurUsdPrice(), PRICE);
    }

    function test_SetEurUsdPrice_AliasWorks() public {
        vm.prank(owner);
        pool.setEurUsdPrice(PRICE + 1);
        assertEq(pool.eurUsdPrice(), PRICE + 1);
    }

    function test_SetEurcPrice_LowerBoundEnforced() public {
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), 50_000_000); // exactly 0.5 allowed
        vm.startPrank(owner);
        vm.expectRevert(OrynPool.InvalidPrice.selector); // 0.45 is within the 10% step but below 0.5
        p.setEurcPrice(45_000_000);
        p.setEurcPrice(55_000_000);
        vm.stopPrank();
        assertEq(p.eurUsdPrice(), 55_000_000);
    }

    function test_SetEurcPrice_UpperBoundEnforced() public {
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), 200_000_000); // exactly 2.0 allowed
        vm.startPrank(owner);
        vm.expectRevert(OrynPool.InvalidPrice.selector); // 2.2 is within the 10% step but above 2.0
        p.setEurcPrice(220_000_000);
        p.setEurcPrice(180_000_000);
        vm.stopPrank();
        assertEq(p.eurUsdPrice(), 180_000_000);
    }

    function test_SetEurcPrice_WalkingDownHitsFloorAndNeverCrossesIt() public {
        bool reverted;
        for (uint256 i; i < 30 && !reverted; ++i) {
            uint256 p = pool.eurUsdPrice();
            uint256 next = p - p / 10;
            vm.prank(owner);
            if (next < 50_000_000) {
                vm.expectRevert(OrynPool.InvalidPrice.selector);
                pool.setEurcPrice(next);
                reverted = true;
            } else {
                pool.setEurcPrice(next);
            }
        }
        assertTrue(reverted);
        assertGe(pool.eurUsdPrice(), 50_000_000);
    }

    function test_SetEurcPrice_WalkingUpHitsCeilingAndNeverCrossesIt() public {
        bool reverted;
        for (uint256 i; i < 30 && !reverted; ++i) {
            uint256 p = pool.eurUsdPrice();
            uint256 next = p + p / 10;
            vm.prank(owner);
            if (next > 200_000_000) {
                vm.expectRevert(OrynPool.InvalidPrice.selector);
                pool.setEurcPrice(next);
                reverted = true;
            } else {
                pool.setEurcPrice(next);
            }
        }
        assertTrue(reverted);
        assertLe(pool.eurUsdPrice(), 200_000_000);
    }

    /// @dev The requested PRICE_UPDATE_INTERVAL does not exist in the contract: nextPriceUpdateTime()
    ///      just returns priceUpdatedAt and updates are allowed back-to-back, even in the same block.
    function test_SetEurcPrice_NoCooldownBetweenUpdates() public {
        _setPrice(PRICE + PRICE / 10);
        assertEq(pool.nextPriceUpdateTime(), pool.priceUpdatedAt());
        _setPrice(pool.eurUsdPrice() + pool.eurUsdPrice() / 10); // same block, second step
        skip(1);
        _setPrice(pool.eurUsdPrice());
    }

    function testFuzz_SetEurcPrice_StepRule(uint256 newPrice) public {
        newPrice = bound(newPrice, 0, 400_000_000);
        uint256 diff = newPrice > PRICE ? newPrice - PRICE : PRICE - newPrice;
        vm.prank(owner);
        if (diff > PRICE / 10) {
            vm.expectRevert(OrynPool.PriceStepTooLarge.selector);
            pool.setEurcPrice(newPrice);
            assertEq(pool.eurUsdPrice(), PRICE);
        } else {
            pool.setEurcPrice(newPrice);
            assertEq(pool.eurUsdPrice(), newPrice);
        }
    }

    // ---------------------------------------------------------------- stale price
    function test_Stale_FreshnessBoundaryIsExactlyMaxAge() public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        skip(7 days); // exactly maxPriceAge -> still fresh
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 10 * M);
        // borrowing does not refresh the oracle; one more second makes it stale
        skip(1);
        assertFalse(pool.isPriceFresh());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, START, 7 days));
        pool.borrow(address(eurc), 1 * M);
    }

    function test_Stale_BlocksBorrowDebtWithdrawAndLiquidate() public {
        _bobPosition(100 * M);
        skip(7 days + 1);
        bytes memory err = abi.encodeWithSelector(OrynPool.StalePrice.selector, START, 7 days);

        vm.prank(bob);
        vm.expectRevert(err);
        pool.borrow(address(eurc), 1 * M);

        vm.prank(bob); // debt-bearing withdraw
        vm.expectRevert(err);
        pool.withdraw(address(usdc), 1 * M);

        vm.prank(liq);
        vm.expectRevert(err);
        pool.liquidate(bob, address(eurc), address(usdc), 1 * M);

        assertEq(pool.maxBorrowable(address(eurc), bob), 0);
        assertEq(pool.maxWithdrawable(address(usdc), bob), 0);
    }

    function test_Stale_DepositRepayAndDebtFreeWithdrawStillWork() public {
        _bobPosition(100 * M);
        _deposit(carol, usdc, 200 * M);
        skip(7 days + 1);
        assertFalse(pool.isPriceFresh());

        _deposit(alice, eurc, 10 * M); // deposit
        _repay(bob, eurc, 30 * M); // partial repay
        _withdraw(carol, usdc, 200 * M); // debt-free withdraw
        _repay(bob, eurc, type(uint256).max); // full repay
        assertEq(pool.debtBalanceOf(address(eurc), bob), 0);
        _withdraw(bob, usdc, type(uint256).max); // now debt-free
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 0);
    }

    function test_Stale_OwnerRefreshRestoresBorrowing() public {
        _bobPosition(100 * M);
        skip(7 days + 1);
        _setPrice(PRICE); // same price refreshes the timestamp
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 1 * M);
        _withdraw(bob, usdc, 1 * M);
    }
}
