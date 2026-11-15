// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev Price reading from the MirrorAggregator feed and staleness gating (maxPriceAge, default 2 days).
contract OrynPoolPriceTest is OrynPoolTestBase {
    // ---------------------------------------------------------------- reading the feed
    function test_Price_FollowsLatestFeedRound() public {
        assertEq(pool.eurUsdPrice(), PRICE);
        skip(1 hours);
        _setPrice(PRICE + 12_345);
        assertEq(pool.eurUsdPrice(), PRICE + 12_345);
        assertEq(pool.eurcUsdPrice(), PRICE + 12_345);
        assertEq(pool.priceOf(address(eurc)), PRICE + 12_345);
        assertEq(pool.priceOf(address(usdc)), USDC_PRICE); // follows its own feed
        assertEq(pool.getReserveData(address(eurc)).price8, PRICE + 12_345);
        assertEq(pool.priceUpdatedAt(), block.timestamp);
    }

    function test_Price_NoStepLimit_AnyPositiveAnswerIsAccepted() public {
        skip(1 hours);
        _setPrice(PRICE * 3); // +200% in one round
        assertEq(pool.eurUsdPrice(), PRICE * 3);
        skip(1 hours);
        _setPrice(1_000_000); // 0.01 USD
        assertEq(pool.eurUsdPrice(), 1_000_000);
    }

    function test_Price_PriceOfUnsupportedAssetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.priceOf(address(0x1234));
    }

    function test_Price_UpdatedAtIsSourceTimestampNotRelayTime() public {
        skip(10 hours);
        uint256 sourceTs = block.timestamp - 3 hours;
        _push(PRICE + 1, sourceTs); // relayed now, but Chainlink produced it 3h ago
        assertEq(pool.priceUpdatedAt(), sourceTs);
        assertLt(pool.priceUpdatedAt(), block.timestamp);
    }

    // ---------------------------------------------------------------- staleness boundary
    function test_Stale_FreshnessBoundaryIsExactlyMaxAge() public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        skip(2 days); // exactly maxPriceAge -> still fresh
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 10 * M);
        // borrowing does not refresh the oracle; one more second makes it stale
        skip(1);
        assertFalse(pool.isPriceFresh());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, START, 2 days));
        pool.borrow(address(eurc), 1 * M);
    }

    function test_Stale_JudgedBySourceTimestamp_NotRelayTime() public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        skip(5 days);
        // The relay pushes NOW a round that Chainlink produced 2 days + 1s ago -> already stale.
        uint256 oldTs = block.timestamp - 2 days - 1;
        _push(PRICE, oldTs);
        assertFalse(pool.isPriceFresh());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, oldTs, 2 days));
        pool.borrow(address(eurc), 1 * M);

        // A round whose source timestamp is 1 day old is fresh for one more day only.
        _push(PRICE, block.timestamp - 1 days);
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 1 * M);
        skip(1 days);
        assertTrue(pool.isPriceFresh());
        skip(1);
        assertFalse(pool.isPriceFresh());
    }

    function test_Stale_BlocksBorrowDebtWithdrawAndLiquidate() public {
        _bobPosition(100 * M);
        skip(2 days + 1);
        bytes memory err = abi.encodeWithSelector(OrynPool.StalePrice.selector, START, 2 days);

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
        skip(2 days + 1);
        assertFalse(pool.isPriceFresh());

        _deposit(alice, eurc, 10 * M); // deposit
        _repay(bob, eurc, 30 * M); // partial repay
        _withdraw(carol, usdc, 200 * M); // debt-free withdraw
        _repay(bob, eurc, type(uint256).max); // full repay
        assertEq(pool.debtBalanceOf(address(eurc), bob), 0);
        _withdraw(bob, usdc, type(uint256).max); // now debt-free
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 0);
    }

    function test_Stale_FreshRoundRestoresBorrowingAndWithdrawals() public {
        _bobPosition(100 * M);
        skip(2 days + 1);
        assertFalse(pool.isPriceFresh());
        _setPrice(PRICE); // same answer, new Chainlink timestamp
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 1 * M);
        _withdraw(bob, usdc, 1 * M);
        assertGt(pool.maxBorrowable(address(eurc), bob), 0);
    }

    function test_Stale_PausedDebtWithdrawRevertsPausedBeforeStale() public {
        _bobPosition(100 * M);
        vm.prank(owner);
        pool.pause();
        skip(2 days + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        pool.withdraw(address(usdc), 1 * M);
    }

    // ---------------------------------------------------------------- maxPriceAge changes
    function test_MaxPriceAge_OwnerCanWidenWindow() public {
        _bobPosition(100 * M);
        skip(2 days + 1);
        assertFalse(pool.isPriceFresh());
        vm.prank(owner);
        pool.setMaxPriceAge(7 days);
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 1 * M);
        skip(5 days); // 7d + 1s since START in total -> stale again
        assertFalse(pool.isPriceFresh());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, START, 7 days));
        pool.borrow(address(eurc), 1 * M);
    }

    function test_MaxPriceAge_OwnerCanTightenWindow() public {
        _bobPosition(100 * M);
        skip(2 hours);
        vm.prank(owner);
        pool.setMaxPriceAge(1 hours);
        assertFalse(pool.isPriceFresh());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, START, 1 hours));
        pool.borrow(address(eurc), 1 * M);
    }

    // ---------------------------------------------------------------- fuzz
    function testFuzz_Freshness_MatchesAgeVersusMaxAge(uint256 maxAge, uint256 age) public {
        maxAge = bound(maxAge, 1 hours, 7 days);
        age = bound(age, 0, 14 days);
        vm.prank(owner);
        pool.setMaxPriceAge(maxAge);
        skip(age);
        assertEq(pool.isPriceFresh(), age <= maxAge);
        if (age > maxAge) {
            assertEq(pool.maxBorrowable(address(eurc), bob), 0);
        }
    }
}
