// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OrynPool} from "../OrynPool.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockAggregator} from "../test-helpers/MockAggregator.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev cirBTC (8 decimals, index 2) market: constructor, accounting, cross-decimal valuation,
///      oracle freshness, liquidation math across 6<->8 decimals and fuzzing.
contract OrynPoolCirBtcTest is OrynPoolTestBase {
    uint256 internal constant ONE_BTC = 1e8;

    // ================================================================ helpers
    function _newPool(address cb, address bf) internal returns (OrynPool p) {
        p = new OrynPool(owner, address(usdc), address(eurc), cb, address(usdcFeed), address(feed), bf);
    }

    function _lastLiquidation() internal returns (uint256 repaid, uint256 seized, bool paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = OrynPool.Liquidation.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                (, repaid, seized, paid) = abi.decode(logs[i].data, (address, uint256, uint256, bool));
                return (repaid, seized, paid);
            }
        }
        revert("no Liquidation event");
    }

    /// @dev alice supplies 200,000 USDC, 10,000 EURC and 100 cirBTC.
    function _liq() internal {
        _deposit(alice, usdc, 200_000 * M);
        _deposit(alice, eurc, 10_000 * M);
        _deposit(alice, cirbtc, 100 * B);
    }

    /// @dev bob: 1 cirBTC collateral, borrows `usdcDebt` USDC (max at 100k is 70,000).
    function _bobBtcCollateral(uint256 usdcDebt) internal {
        _liq();
        _deposit(bob, cirbtc, 1 * B);
        if (usdcDebt != 0) _borrow(bob, usdc, usdcDebt);
    }

    /// @dev bob: 100,000 USDC collateral, borrows `btcDebt` sats of cirBTC (max at 100k is 0.8).
    function _bobUsdcCollateral(uint256 btcDebt) internal {
        _liq();
        _deposit(bob, usdc, 100_000 * M);
        if (btcDebt != 0) _borrow(bob, cirbtc, btcDebt);
    }

    function _refreshEurc() internal {
        vm.prank(updater);
        feed.pushRound(int256(PRICE), block.timestamp, ++srcRound);
        lastPushTs = block.timestamp;
    }

    /// @dev Lets only the BTC feed age past maxPriceAge; USDC/EURC are refreshed.
    function _makeBtcStale() internal {
        skip(2 days + 1);
        _setUsdcPrice(USDC_PRICE);
        _refreshEurc();
    }

    function _assertSolvent(MockERC20 t) internal view {
        OrynPool.ReserveData memory d = pool.getReserveData(address(t));
        assertGe(t.balanceOf(address(pool)) + d.totalBorrowed, d.totalSupplied);
    }

    function _assertAllSolvent() internal view {
        _assertSolvent(usdc);
        _assertSolvent(eurc);
        _assertSolvent(cirbtc);
    }

    // ================================================================ constructor
    function test_Constructor_CirBtcState() public view {
        assertEq(pool.CIRBTC(), address(cirbtc));
        assertEq(pool.cirBtcUnit(), 1e8);
        assertEq(pool.usdcUnit(), 1e6);
        assertEq(pool.eurcUnit(), 1e6);
        assertEq(address(pool.btcUsdFeed()), address(btcFeed));
        assertEq(pool.btcFeedDecimals(), 8);
        assertEq(pool.btcUsdPrice(), BTC_PRICE);
        assertEq(pool.btcPriceUpdatedAt(), START);
        assertEq(pool.priceOf(address(cirbtc)), BTC_PRICE);
        assertTrue(pool.isPriceFresh());
    }

    function test_Constructor_AssetsReturnsThree() public view {
        (address u, address e, address c) = pool.assets();
        assertEq(u, address(usdc));
        assertEq(e, address(eurc));
        assertEq(c, address(cirbtc));
    }

    function test_Constructor_CirBtcInitialRiskParams() public view {
        OrynPool.ReserveData memory d = pool.getReserveData(address(cirbtc));
        assertEq(d.ltv, 7_000);
        assertEq(d.liquidationThreshold, 7_500);
        assertEq(d.liquidationBonus, 800);
        assertEq(d.supplyCap, 0);
        assertEq(d.borrowCap, 0);
        assertEq(d.price8, BTC_PRICE);
        // existing markets keep their parameters
        assertEq(pool.getReserveData(address(usdc)).ltv, 8_000);
        assertEq(pool.getReserveData(address(eurc)).ltv, 7_500);
    }

    function test_Constructor_EmitsParamsUpdatedForCirBtc() public {
        vm.expectEmit(true, false, false, true);
        emit OrynPool.ParamsUpdated(address(cirbtc), 7_000, 7_500, 800, 0, 0);
        _newPool(address(cirbtc), address(btcFeed));
    }

    function test_Constructor_ZeroCirBtcReverts() public {
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        _newPool(address(0), address(btcFeed));
    }

    function test_Constructor_IdenticalCirBtcReverts() public {
        vm.expectRevert(OrynPool.IdenticalAssets.selector);
        _newPool(address(usdc), address(btcFeed));
        vm.expectRevert(OrynPool.IdenticalAssets.selector);
        _newPool(address(eurc), address(btcFeed));
    }

    function test_Constructor_ZeroBtcFeedReverts() public {
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        _newPool(address(cirbtc), address(0));
    }

    function test_Constructor_NoCodeBtcFeedReverts() public {
        vm.expectRevert();
        _newPool(address(cirbtc), makeAddr("notAFeed"));
    }

    function test_Constructor_NoCodeCirBtcReverts() public {
        vm.expectRevert();
        _newPool(makeAddr("notAToken"), address(btcFeed));
    }

    function test_Constructor_BtcFeedDecimalsAbove18Reverts() public {
        MockAggregator bad = new MockAggregator(19);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        _newPool(address(cirbtc), address(bad));
        MockAggregator ok = new MockAggregator(18);
        assertEq(_newPool(address(cirbtc), address(ok)).btcFeedDecimals(), 18);
    }

    function test_Constructor_TokenDecimalsAbove18Reverts() public {
        MockERC20 bad = new MockERC20("Bad", "BAD", 19);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedDecimals.selector, address(bad), uint8(19)));
        _newPool(address(bad), address(btcFeed));
        // the check applies to every asset
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedDecimals.selector, address(bad), uint8(19)));
        new OrynPool(owner, address(bad), address(eurc), address(cirbtc), address(usdcFeed), address(feed), address(btcFeed));
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedDecimals.selector, address(bad), uint8(19)));
        new OrynPool(owner, address(usdc), address(bad), address(cirbtc), address(usdcFeed), address(feed), address(btcFeed));
    }

    function test_Constructor_18DecimalCirBtcAccepted() public {
        MockERC20 t = new MockERC20("Wide", "W", 18);
        assertEq(_newPool(address(t), address(btcFeed)).cirBtcUnit(), 1e18);
        MockERC20 z = new MockERC20("Zero", "Z", 0);
        assertEq(_newPool(address(z), address(btcFeed)).cirBtcUnit(), 1);
    }

    function test_Constructor_DoesNotRequireInitialBtcRound() public {
        MockAggregator empty = new MockAggregator(8);
        OrynPool p = _newPool(address(cirbtc), address(empty));
        assertFalse(p.isPriceFresh());
        assertEq(p.btcPriceUpdatedAt(), 0);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.btcUsdPrice();
    }

    function test_RescueToken_CirBtcIsNotRescuable() public {
        vm.prank(owner);
        vm.expectRevert(OrynPool.InvalidRecipient.selector);
        pool.rescueToken(address(cirbtc), owner, 1);
    }

    function test_UnsupportedAssetStillRejected() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0xBEEF)));
        pool.deposit(address(0xBEEF), 1);
    }

    // ================================================================ deposit / withdraw / borrow / repay
    function test_Deposit_CirBtcExactAmount() public {
        uint256 amt = 123_456_789; // 1.23456789 cirBTC
        uint256 before = cirbtc.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.Deposit(alice, address(cirbtc), amt, amt);
        _deposit(alice, cirbtc, amt);
        assertEq(cirbtc.balanceOf(alice), before - amt);
        assertEq(cirbtc.balanceOf(address(pool)), amt);
        assertEq(pool.supplyBalanceOf(address(cirbtc), alice), amt);
        assertEq(pool.scaledSupplyOf(address(cirbtc), alice), amt);
        assertEq(pool.getMarket(address(cirbtc)).totalSupply, amt);
        // collateral valued at amt * 1e13 / 1e8, rounded down
        assertEq(pool.getAccountData(alice).collateralValueUsd, amt * 1e5);
    }

    function test_Deposit_OneSatoshiValueRoundsDown() public {
        _setBtcPrice(99_999); // $0.00099999 per BTC
        _deposit(alice, cirbtc, 1);
        assertEq(pool.getAccountData(alice).collateralValueUsd, 0); // floor(1 * 99999 / 1e8)
        _deposit(alice, cirbtc, 1_000);
        assertEq(pool.getAccountData(alice).collateralValueUsd, 1); // floor(1001 * 99999 / 1e8)
    }

    function test_Deposit_ZeroAmountReverts() public {
        vm.prank(alice);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.deposit(address(cirbtc), 0);
    }

    function test_Withdraw_CirBtcExactAmountAndMax() public {
        _deposit(bob, cirbtc, 123_456_789);
        uint256 before = cirbtc.balanceOf(bob);
        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.Withdraw(bob, address(cirbtc), 23_456_789, 23_456_789);
        _withdraw(bob, cirbtc, 23_456_789);
        assertEq(cirbtc.balanceOf(bob), before + 23_456_789);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 1e8);
        _withdraw(bob, cirbtc, type(uint256).max);
        assertEq(cirbtc.balanceOf(bob), before + 123_456_789);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 0);
        assertEq(cirbtc.balanceOf(address(pool)), 0);
    }

    function test_Withdraw_MoreThanBalanceReverts() public {
        _deposit(bob, cirbtc, 1e8);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientSupply.selector);
        pool.withdraw(address(cirbtc), 1e8 + 1);
        vm.prank(bob);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.withdraw(address(cirbtc), 0);
    }

    function test_Borrow_CirBtcExactAmountAndRepay() public {
        _liq();
        _deposit(bob, usdc, 100_000 * M);
        uint256 before = cirbtc.balanceOf(bob);
        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.Borrow(bob, address(cirbtc), 12_345_678, 12_345_678);
        _borrow(bob, cirbtc, 12_345_678);
        assertEq(cirbtc.balanceOf(bob), before + 12_345_678);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 12_345_678);
        assertEq(cirbtc.balanceOf(address(pool)), 100 * B - 12_345_678);
        assertEq(pool.getAccountData(bob).borrowValueUsd, 12_345_678 * 1e5);

        vm.expectEmit(true, true, true, true, address(pool));
        emit OrynPool.Repay(bob, bob, address(cirbtc), 2_345_678, 2_345_678);
        _repay(bob, cirbtc, 2_345_678);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 10_000_000);

        _repay(bob, cirbtc, type(uint256).max);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 0);
        assertEq(cirbtc.balanceOf(bob), before); // paid back exactly what was borrowed (no time elapsed)
        assertEq(cirbtc.balanceOf(address(pool)), 100 * B);
    }

    function test_Borrow_CirBtcZeroAndOverLiquidityRevert() public {
        _liq();
        _deposit(bob, usdc, 100_000 * M);
        vm.prank(bob);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.borrow(address(cirbtc), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.InsufficientLiquidity.selector, address(cirbtc), 101 * B, 100 * B));
        pool.borrow(address(cirbtc), 101 * B);
    }

    function test_Repay_CirBtcZeroReverts() public {
        _bobUsdcCollateral(1e7);
        vm.prank(bob);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.repay(address(cirbtc), 0);
    }

    function test_Views_UserPositionAndAccountDataHaveThreeSlots() public {
        _bobUsdcCollateral(4e7);
        OrynPool.UserPosition memory p = pool.getUserPosition(bob);
        assertEq(p.supplyBalances[0], 100_000 * M);
        assertEq(p.supplyBalances[1], 0);
        assertEq(p.supplyBalances[2], 0);
        assertEq(p.debtBalances[0], 0);
        assertEq(p.debtBalances[1], 0);
        assertEq(p.debtBalances[2], 4e7);
        assertEq(p.totalSupplyValueUsd, 100_000e8);
        assertEq(p.totalDebtValueUsd, 40_000e8);

        OrynPool.AccountData memory d = pool.getAccountData(bob);
        assertEq(d.collateralValueUsd, 100_000e8);
        assertEq(d.borrowValueUsd, 40_000e8);
        assertEq(d.borrowLimitUsd, 80_000e8);
        assertEq(d.liquidationLimitUsd, 85_000e8);
        assertEq(d.maxBorrow[2], 4e7); // 0.4 cirBTC more fits under the 80k limit
        assertEq(d.maxBorrow[2], pool.maxBorrowable(address(cirbtc), bob));
        assertEq(d.maxBorrow[0], pool.maxBorrowable(address(usdc), bob));
        assertEq(d.maxBorrow[1], pool.maxBorrowable(address(eurc), bob));
        assertEq(d.healthFactorWad, 85_000e8 * 1e18 / 40_000e8);

        OrynPool.UserPosition memory c = _positionOfCollateralBtcHolder();
        assertEq(c.supplyBalances[2], 1e8);
        assertEq(c.totalSupplyValueUsd, 100_000e8);
    }

    function _positionOfCollateralBtcHolder() internal returns (OrynPool.UserPosition memory) {
        _deposit(carol, cirbtc, 1e8);
        return pool.getUserPosition(carol);
    }

    // ================================================================ cross-decimal borrow limits (LTV)
    function test_Borrow_UsdcAgainstCirBtc_ExactlyAt70PercentLtv() public {
        _liq();
        _deposit(bob, cirbtc, 1 * B); // $100,000 -> limit $70,000
        assertEq(pool.getAccountData(bob).borrowLimitUsd, 70_000e8);
        assertEq(pool.maxBorrowable(address(usdc), bob), 70_000 * M);
        _borrow(bob, usdc, 70_000 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 70_000 * M);
        assertEq(pool.getAccountData(bob).borrowValueUsd, 70_000e8);
        assertEq(pool.maxBorrowable(address(usdc), bob), 0);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(usdc), 1);
    }

    function test_Borrow_UsdcAgainstCirBtc_OneUnitOverReverts() public {
        _liq();
        _deposit(bob, cirbtc, 1 * B);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(usdc), 70_000 * M + 1);
    }

    function test_Borrow_CirBtcAgainstUsdc_ExactBoundary() public {
        _liq();
        _deposit(bob, usdc, 100_000 * M); // limit $80,000 = exactly 0.8 cirBTC at $100k
        assertEq(pool.maxBorrowable(address(cirbtc), bob), 8e7);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(cirbtc), 8e7 + 1);
        _borrow(bob, cirbtc, 8e7);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 8e7);
        assertEq(pool.getAccountData(bob).borrowValueUsd, 80_000e8);
        assertEq(pool.maxBorrowable(address(cirbtc), bob), 0);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(cirbtc), 1);
    }

    function test_Borrow_CirBtcDebtRoundsUpPerSatoshi() public {
        // at $0.5 per BTC one sat is worth 0.5e-8 USD -> debt value rounds UP to 1, collateral rounds DOWN
        _liq();
        _deposit(bob, usdc, 100_000 * M);
        _setBtcPrice(50_000_000); // $0.50
        _borrow(bob, cirbtc, 1);
        assertEq(pool.getAccountData(bob).borrowValueUsd, 1);
        _borrow(bob, cirbtc, 1);
        assertEq(pool.getAccountData(bob).borrowValueUsd, 1); // ceil(2 * 0.5) = 1
        _borrow(bob, cirbtc, 1);
        assertEq(pool.getAccountData(bob).borrowValueUsd, 2); // ceil(3 * 0.5) = 2
    }

    function test_Borrow_MixedCollateralCirBtcAndUsdcCounts() public {
        _liq();
        _deposit(bob, cirbtc, 1 * B); // 70,000 limit
        _deposit(bob, usdc, 10_000 * M); // 8,000 limit
        assertEq(pool.getAccountData(bob).borrowLimitUsd, 78_000e8);
        assertEq(pool.maxBorrowable(address(eurc), bob), 10_000 * M); // cash-limited (alice supplies 10,000 EURC)
        assertEq(pool.maxBorrowable(address(usdc), bob), 78_000 * M);
    }

    // ================================================================ maxBorrowable / maxWithdrawable exactness
    function _assertMaxBorrowExact(address user, MockERC20 t) internal {
        uint256 m = pool.maxBorrowable(address(t), user);
        assertGt(m, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(user);
        vm.expectRevert();
        pool.borrow(address(t), m + 1);
        vm.prank(user);
        pool.borrow(address(t), m);
        assertEq(pool.maxBorrowable(address(t), user), 0);
        vm.revertToState(snap);
    }

    function test_MaxBorrowable_Exact_AtOddBtcPrices() public {
        _liq();
        _deposit(bob, cirbtc, 123_456_789);
        uint256[4] memory prices = [uint256(97_531_86420_135), 100_000e8 + 7, 1_234_567_891_011, 3];
        for (uint256 i; i < 4; ++i) {
            _setBtcPrice(prices[i]);
            if (pool.maxBorrowable(address(usdc), bob) > 0) _assertMaxBorrowExact(bob, usdc);
            if (pool.maxBorrowable(address(eurc), bob) > 0) _assertMaxBorrowExact(bob, eurc);
        }
    }

    function test_MaxBorrowable_CirBtc_ExactAtOddBtcPrices() public {
        _liq();
        _deposit(bob, usdc, 77_777_777); // 77.777777 USDC
        uint256[3] memory prices = [uint256(97_531_86420_135), 5_000_000_000_000, 31_415_926_535];
        for (uint256 i; i < 3; ++i) {
            _setBtcPrice(prices[i]);
            if (pool.maxBorrowable(address(cirbtc), bob) > 0) _assertMaxBorrowExact(bob, cirbtc);
        }
    }

    function test_MaxWithdrawable_CirBtcCollateral_ExactBoundary() public {
        _bobBtcCollateral(35_000 * M); // needs $35,000 capacity -> 0.5 cirBTC must stay
        assertEq(pool.maxWithdrawable(address(cirbtc), bob), 5e7);
        _withdraw(bob, cirbtc, 5e7);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 5e7);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(cirbtc), 1);
        assertEq(pool.maxWithdrawable(address(cirbtc), bob), 0);
    }

    function test_MaxWithdrawable_CirBtc_OneOverReverts() public {
        _bobBtcCollateral(35_000 * M);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(cirbtc), 5e7 + 1);
    }

    function test_MaxWithdrawable_UsdcCollateralAgainstCirBtcDebt_ExactBoundary() public {
        _bobUsdcCollateral(4e7); // $40,000 debt at 80% LTV -> $50,000 USDC must stay
        assertEq(pool.maxWithdrawable(address(usdc), bob), 50_000 * M);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(usdc), 50_000 * M + 1);
        _withdraw(bob, usdc, 50_000 * M);
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 50_000 * M);
    }

    function test_MaxWithdrawable_DebtFreeIsBalanceCappedByCash() public {
        _deposit(bob, cirbtc, 5 * B);
        assertEq(pool.maxWithdrawable(address(cirbtc), bob), 5 * B);
        _deposit(carol, usdc, 1_000_000 * M); // limit $800,000 = 8 cirBTC
        _borrow(carol, cirbtc, 45e7); // drain pool cash down to 0.5 cirBTC
        assertEq(cirbtc.balanceOf(address(pool)), 5e7);
        assertEq(pool.maxWithdrawable(address(cirbtc), bob), 5e7);
        _withdraw(bob, cirbtc, 5e7);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.InsufficientLiquidity.selector, address(cirbtc), 1, 0));
        pool.withdraw(address(cirbtc), 1);
    }

    // ================================================================ stale / invalid BTC feed
    function _assertBtcRiskBlocked() internal {
        bytes memory err = abi.encodeWithSelector(OrynPool.StalePrice.selector, pool.priceUpdatedAt(), 2 days);
        assertFalse(pool.isPriceFresh());

        vm.prank(bob);
        vm.expectRevert(err);
        pool.borrow(address(usdc), 1 * M);
        vm.prank(bob);
        vm.expectRevert(err);
        pool.borrow(address(cirbtc), 1);
        vm.prank(bob); // withdraw while holding debt
        vm.expectRevert(err);
        pool.withdraw(address(cirbtc), 1);
        vm.prank(liq);
        vm.expectRevert(err);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1 * M);

        // views never revert on an unusable BTC feed
        assertEq(pool.maxBorrowable(address(usdc), bob), 0);
        assertEq(pool.maxBorrowable(address(cirbtc), bob), 0);
        assertEq(pool.maxWithdrawable(address(cirbtc), bob), 0);
    }

    function _assertBtcNonRiskOpen() internal {
        vm.startPrank(carol);
        pool.deposit(address(usdc), 100 * M);
        pool.withdraw(address(usdc), type(uint256).max); // debt-free withdraw reads no feed
        pool.deposit(address(cirbtc), 1 * B);
        assertEq(pool.maxWithdrawable(address(cirbtc), carol), 1 * B);
        pool.withdraw(address(cirbtc), type(uint256).max);
        vm.stopPrank();
        _deposit(alice, eurc, 5 * M);
        uint256 debtBefore = pool.debtBalanceOf(address(usdc), bob);
        _repay(bob, usdc, 400 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), debtBefore - 400 * M);
        _repay(bob, usdc, type(uint256).max);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 0);
        _withdraw(bob, cirbtc, type(uint256).max); // debt-free now
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 0);
    }

    function test_StaleBtc_BlocksRiskActions_NotRepayDeposit() public {
        _bobBtcCollateral(1_000 * M);
        uint256 btcTs = pool.btcPriceUpdatedAt();
        _makeBtcStale(); // USDC and EURC fresh, only BTC is older than 2 days
        assertEq(pool.usdcPriceUpdatedAt(), block.timestamp);
        assertEq(pool.btcPriceUpdatedAt(), btcTs);
        assertEq(pool.priceUpdatedAt(), btcTs);
        assertEq(pool.btcUsdPrice(), BTC_PRICE); // indicative quote still readable while stale
        _assertBtcRiskBlocked();
        _assertBtcNonRiskOpen();
    }

    function test_StaleBtc_ExactMaxAgeBoundary() public {
        _bobBtcCollateral(1_000 * M);
        skip(2 days);
        _setUsdcPrice(USDC_PRICE);
        _refreshEurc();
        assertTrue(pool.isPriceFresh()); // BTC age == maxPriceAge exactly
        _borrow(bob, usdc, 1 * M);
        skip(1);
        _setUsdcPrice(USDC_PRICE);
        _refreshEurc();
        assertFalse(pool.isPriceFresh()); // age == maxPriceAge + 1
    }

    function test_StaleBtc_RecoversWhenRefreshed() public {
        _bobBtcCollateral(1_000 * M);
        _makeBtcStale();
        assertFalse(pool.isPriceFresh());
        _setBtcPrice(BTC_PRICE);
        assertTrue(pool.isPriceFresh());
        _borrow(bob, usdc, 1 * M);
        assertGe(pool.debtBalanceOf(address(usdc), bob), 1_001 * M); // original debt + interest + new borrow
    }

    function test_InvalidBtc_ZeroAnswer_Blocks() public {
        _bobBtcCollateral(1_000 * M);
        btcFeed.setRound(0, block.timestamp);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.btcUsdPrice();
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.priceOf(address(cirbtc));
        assertEq(pool.btcPriceUpdatedAt(), block.timestamp);
        _assertBtcRiskBlocked();
        _assertBtcNonRiskOpen();
    }

    function test_InvalidBtc_NegativeAnswer_Blocks() public {
        _bobBtcCollateral(1_000 * M);
        btcFeed.setRound(-1, block.timestamp);
        _assertBtcRiskBlocked();
        _assertBtcNonRiskOpen();
    }

    function test_InvalidBtc_RevertingFeed_Blocks() public {
        _bobBtcCollateral(1_000 * M);
        btcFeed.setRevert(true);
        assertEq(pool.btcPriceUpdatedAt(), 0);
        assertEq(pool.priceUpdatedAt(), 0);
        _assertBtcRiskBlocked();
        _assertBtcNonRiskOpen();
    }

    function test_InvalidBtc_IncompleteRound_Blocks() public {
        _bobBtcCollateral(1_000 * M);
        btcFeed.setRaw(9, int256(BTC_PRICE), block.timestamp, block.timestamp, 8);
        _assertBtcRiskBlocked();
        _assertBtcNonRiskOpen();
    }

    function test_InvalidBtc_ZeroUpdatedAt_Blocks() public {
        _bobBtcCollateral(1_000 * M);
        btcFeed.setRaw(5, int256(BTC_PRICE), 0, 0, 5);
        _assertBtcRiskBlocked();
        _assertBtcNonRiskOpen();
    }

    function test_InvalidBtc_FutureTimestamp_BlocksUntilClockCatchesUp() public {
        _bobBtcCollateral(1_000 * M);
        btcFeed.setRound(int256(BTC_PRICE), block.timestamp + 1);
        _assertBtcRiskBlocked();
        skip(1);
        assertTrue(pool.isPriceFresh());
    }

    function test_InvalidBtc_FreshnessViewsNeverRevert() public {
        btcFeed.setRevert(true);
        assertFalse(pool.isPriceFresh());
        assertEq(pool.maxBorrowable(address(usdc), alice), 0);
        assertEq(pool.maxWithdrawable(address(usdc), alice), 0);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.getReserveData(address(cirbtc));
        // price-free views still work
        _deposit(alice, cirbtc, 1 * B);
        assertEq(pool.getMarket(address(cirbtc)).totalSupply, 1 * B);
        assertEq(pool.maxWithdrawable(address(cirbtc), alice), 1 * B);
    }

    function test_InvalidBtc_LiquidationBlockedEvenWhenPositionUnderwater() public {
        _bobBtcCollateral(70_000 * M);
        _setBtcPrice(50_000e8);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        btcFeed.setRound(0, block.timestamp); // oracle then breaks
        vm.prank(liq);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, block.timestamp, 2 days));
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M);
    }

    // ================================================================ BTC feed decimals scaling
    function _poolWithBtcFeed(uint8 dec, int256 answer) internal returns (OrynPool p) {
        MockAggregator m = new MockAggregator(dec);
        m.setRound(answer, block.timestamp);
        p = _newPool(address(cirbtc), address(m));
        _fund(p);
    }

    function _assertBtcScaledCorrectly(OrynPool p) internal {
        assertEq(p.btcUsdPrice(), BTC_PRICE);
        assertEq(p.priceOf(address(cirbtc)), BTC_PRICE);
        assertTrue(p.isPriceFresh());
        vm.prank(alice);
        p.deposit(address(usdc), 100_000 * M);
        vm.prank(bob);
        p.deposit(address(cirbtc), 1 * B);
        assertEq(p.getAccountData(bob).collateralValueUsd, 100_000e8);
        assertEq(p.getAccountData(bob).borrowLimitUsd, 70_000e8);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        p.borrow(address(usdc), 70_000 * M + 1);
        vm.prank(bob);
        p.borrow(address(usdc), 70_000 * M);
    }

    function test_BtcScaling_18Decimals() public {
        OrynPool p = _poolWithBtcFeed(18, int256(100_000e18));
        assertEq(p.btcFeedDecimals(), 18);
        _assertBtcScaledCorrectly(p);
    }

    function test_BtcScaling_6Decimals() public {
        OrynPool p = _poolWithBtcFeed(6, int256(100_000e6));
        assertEq(p.btcFeedDecimals(), 6);
        _assertBtcScaledCorrectly(p);
    }

    function test_BtcScaling_0Decimals() public {
        OrynPool p = _poolWithBtcFeed(0, 100_000);
        assertEq(p.btcFeedDecimals(), 0);
        _assertBtcScaledCorrectly(p);
    }

    function test_BtcScaling_18DecimalsTruncatesTowardZero() public {
        OrynPool p = _poolWithBtcFeed(18, int256(100_000e18 + 9_999_999_999));
        assertEq(p.btcUsdPrice(), BTC_PRICE);
        MockAggregator tiny = new MockAggregator(18);
        tiny.setRound(9_999_999_999, block.timestamp); // rounds to zero -> invalid
        OrynPool q = _newPool(address(cirbtc), address(tiny));
        assertFalse(q.isPriceFresh());
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        q.btcUsdPrice();
    }

    function testFuzz_BtcScaling_MatchesExpectedConversion(uint8 dec, uint256 usdPrice) public {
        dec = uint8(bound(dec, 0, 18));
        usdPrice = bound(usdPrice, 1, 10_000_000); // up to $10M per BTC
        OrynPool p = _poolWithBtcFeed(dec, int256(usdPrice * 10 ** uint256(dec)));
        assertEq(p.btcUsdPrice(), usdPrice * 1e8);
        vm.prank(bob);
        p.deposit(address(cirbtc), 1 * B);
        assertEq(p.getAccountData(bob).collateralValueUsd, usdPrice * 1e8);
    }

    // ================================================================ liquidation: cirBTC collateral / USDC debt
    function test_Liquidate_HealthyCirBtcPositionReverts() public {
        _bobBtcCollateral(70_000 * M);
        assertGt(pool.getAccountData(bob).healthFactorWad, 1e18 - 1); // 7.5/7.0 * 1 -> healthy
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M);
    }

    function test_Liquidate_ThresholdBoundaryAcross8DecimalCollateral() public {
        _bobBtcCollateral(70_000 * M); // debt value = 7e12
        // liquidation value = floor(price * 7500 / 10000); debt <= liquidationValue means healthy
        _setBtcPrice(9_333_333_333_334); // floor(...*0.75) = 7_000_000_000_000 -> exactly at the limit
        assertEq(pool.getAccountData(bob).liquidationLimitUsd, 7_000_000_000_000);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M);

        _setBtcPrice(9_333_333_333_333); // one 1e-8 USD lower -> floor = 6_999_999_999_999 < debt
        assertEq(pool.getAccountData(bob).liquidationLimitUsd, 6_999_999_999_999);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 69_000 * M);
    }

    function test_Liquidate_UsdcDebt_CirBtcCollateral_CloseFactorAndBonusExact() public {
        _bobBtcCollateral(70_000 * M);
        _setBtcPrice(90_000e8); // liquidation value 67,500 < debt 70,000
        uint256 liqUsdc = usdc.balanceOf(liq);
        uint256 liqBtc = cirbtc.balanceOf(liq);
        uint256 poolBtc = cirbtc.balanceOf(address(pool));

        // asks for 100% of debt; close factor 50% => 35,000 USDC
        // seized = floor(35,000e6 * 1e8 * 1e8 * 10,800 / (90,000e8 * 1e6 * 10,000)) = 42,000,000 exactly
        vm.expectEmit(true, true, true, true, address(pool));
        emit OrynPool.Liquidation(liq, bob, address(usdc), address(cirbtc), 35_000 * M, 42_000_000, true);
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), 70_000 * M);

        assertEq(liqUsdc - usdc.balanceOf(liq), 35_000 * M);
        assertEq(cirbtc.balanceOf(liq) - liqBtc, 42_000_000);
        assertEq(poolBtc - cirbtc.balanceOf(address(pool)), 42_000_000);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 35_000 * M);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 1e8 - 42_000_000);
        _assertAllSolvent();
    }

    function test_Liquidate_UsdcDebt_PartialRepaySeizesProportionally() public {
        _bobBtcCollateral(70_000 * M);
        _setBtcPrice(90_000e8);
        // 10,000 USDC -> floor(1e10*1e8*1e8*10,800/(9e12*1e6*10,000)) = 12,000,000 sats exactly
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), 10_000 * M);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();
        assertEq(repaid, 10_000 * M);
        assertEq(seized, 12_000_000);
        assertTrue(paid);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 60_000 * M);
    }

    function test_Liquidate_UsdcDebt_CappedByBorrowerCirBtcCollateral() public {
        _bobBtcCollateral(70_000 * M);
        _setBtcPrice(30_000e8); // collateral $30,000 vs debt $70,000: collateral, not the close factor, binds
        // seized(x) = floor(x * 0.0036) (micro-USDC -> sats incl. 8% bonus at $30k). Largest x with
        // seized <= 1e8 is the strict inverse x < (1e8 + 1) / 0.0036 = 27,777,778,055.55 -> 27,777,778,055;
        // seized = floor(27,777,778,055 * 0.0036) = 100,000,000 (all collateral)
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), 70_000 * M);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();
        assertEq(repaid, 27_777_778_055);
        assertEq(seized, 1e8);
        assertTrue(paid);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 0);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 70_000 * M - 27_777_778_055);
        _assertAllSolvent();
    }

    function test_Liquidate_UsdcDebt_SharePayoutWhenCirBtcCashShort() public {
        _deposit(alice, usdc, 100_000 * M);
        _deposit(alice, cirbtc, 1 * B);
        _deposit(bob, cirbtc, 1 * B);
        _borrow(bob, usdc, 70_000 * M);
        _deposit(carol, usdc, 300_000 * M);
        _borrow(carol, cirbtc, 195_000_000); // leaves 0.05 cirBTC of cash
        assertEq(cirbtc.balanceOf(address(pool)), 5_000_000);
        _setBtcPrice(90_000e8);

        uint256 liqBtc = cirbtc.balanceOf(liq);
        vm.expectEmit(true, true, true, true, address(pool));
        emit OrynPool.Liquidation(liq, bob, address(usdc), address(cirbtc), 35_000 * M, 42_000_000, false);
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), 70_000 * M);

        assertEq(cirbtc.balanceOf(liq), liqBtc); // no underlying paid out
        assertEq(cirbtc.balanceOf(address(pool)), 5_000_000);
        assertEq(pool.supplyBalanceOf(address(cirbtc), liq), 42_000_000); // received supply claim instead
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 1e8 - 42_000_000);
        _assertAllSolvent();
    }

    // ================================================================ liquidation: USDC collateral / cirBTC debt
    function test_Liquidate_CirBtcDebt_UsdcCollateral_CloseFactorAndBonusExact() public {
        _bobUsdcCollateral(8e7); // $80,000 debt = the 80% limit
        _setBtcPrice(110_000e8); // debt $88,000 > liquidation value $85,000
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        uint256 liqUsdc = usdc.balanceOf(liq);
        uint256 liqBtc = cirbtc.balanceOf(liq);

        // close factor: 0.4 cirBTC ($44,000); seized = 44,000 * 1.05 = 46,200 USDC
        vm.expectEmit(true, true, true, true, address(pool));
        emit OrynPool.Liquidation(liq, bob, address(cirbtc), address(usdc), 4e7, 46_200 * M, true);
        vm.prank(liq);
        pool.liquidate(bob, address(cirbtc), address(usdc), 8e7);

        assertEq(liqBtc - cirbtc.balanceOf(liq), 4e7);
        assertEq(usdc.balanceOf(liq) - liqUsdc, 46_200 * M);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 4e7);
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 53_800 * M);
        _assertAllSolvent();
    }

    function test_Liquidate_CirBtcDebt_PartialRepay() public {
        _bobUsdcCollateral(8e7);
        _setBtcPrice(110_000e8);
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(cirbtc), address(usdc), 1e7); // 0.1 BTC = $11,000 -> 11,550 USDC
        (uint256 repaid, uint256 seized,) = _lastLiquidation();
        assertEq(repaid, 1e7);
        assertEq(seized, 11_550 * M);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 7e7);
    }

    function test_Liquidate_CirBtcDebt_CappedByBorrowerUsdcCollateral() public {
        _liq();
        _deposit(bob, usdc, 1_000 * M);
        _borrow(bob, cirbtc, 800_000); // 0.008 BTC = $800 = 80% limit
        _setBtcPrice(1_000_000e8); // debt $8,000 vs $1,000 collateral
        // collateral-limited repay: floor(1000e6/1.05)=952,380,952 USDC -> floor(/ $1M per BTC) = 95,238 sats
        // seized = ceil(95,238 sats = 952,380,000 USDC units * 1.05) = 999,999,000
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(cirbtc), address(usdc), 800_000);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();
        assertEq(repaid, 95_238);
        assertEq(seized, 999_999_000);
        assertTrue(paid);
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 1_000);
        assertEq(pool.debtBalanceOf(address(cirbtc), bob), 800_000 - 95_238);
        _assertAllSolvent();
    }

    function test_Liquidate_CirBtcDebt_BtcPriceMustRiseNotFall() public {
        _bobUsdcCollateral(8e7);
        _setBtcPrice(90_000e8); // debt gets cheaper
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(cirbtc), address(usdc), 1e7);
    }

    function test_Liquidate_EurcDebt_CirBtcCollateral_CrossDecimalSeizure() public {
        _liq();
        _deposit(bob, cirbtc, 1e7); // 0.1 BTC, $10,000 at 100k
        uint256 debt = pool.maxBorrowable(address(eurc), bob); // ~ $7,000 of EURC
        _borrow(bob, eurc, debt);
        // collateral $9,000, liq value $6,750 < ~$7,000 debt; HF ~0.96 keeps the 50% close factor
        _setBtcPrice(90_000e8);
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(cirbtc), type(uint256).max);
        (uint256 repaid, uint256 seized,) = _lastLiquidation();
        assertEq(repaid, debt / 2); // close factor, debt has no interest at same timestamp
        // single floor: floor(repaid * PRICE * 1e8 * 10,800 / (90,000e8 * 1e6 * 10,000))
        assertEq(seized, Math.mulDiv(repaid * PRICE * 1e8, 10_800, 90_000e8 * 1e6 * 10_000));
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 1e7 - seized);
    }

    function test_Liquidate_ZeroRepayAndZeroBorrowerRevert() public {
        _bobBtcCollateral(70_000 * M);
        _setBtcPrice(90_000e8);
        vm.prank(liq);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 0);
        vm.prank(liq);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.liquidate(address(0), address(usdc), address(cirbtc), 1);
    }

    // ================================================================ fuzz: cross-decimal valuation
    function _u(address t) internal view returns (uint256) {
        return t == address(cirbtc) ? 1e8 : 1e6;
    }

    function testFuzz_Valuation_CollateralRoundsDownDebtRoundsUp(uint256 sats, uint256 price, uint256 borrowSats)
        public
    {
        sats = bound(sats, 1, 1e12);
        price = bound(price, 1e6, 1e15); // $0.01 .. $10,000,000
        _deposit(alice, cirbtc, 100 * B);
        _setBtcPrice(price);
        _deposit(bob, cirbtc, sats);
        uint256 value = Math.mulDiv(sats, price, 1e8);
        OrynPool.AccountData memory d = pool.getAccountData(bob);
        assertEq(d.collateralValueUsd, value);
        assertEq(d.borrowLimitUsd, Math.mulDiv(value, 7_000, 10_000));
        assertEq(d.liquidationLimitUsd, Math.mulDiv(value, 7_500, 10_000));
        assertEq(pool.getUserPosition(bob).totalSupplyValueUsd, value);

        // debt side: carol borrows cirBTC against a huge USDC deposit
        _deposit(carol, usdc, 50_000_000 * M);
        uint256 cap = Math.mulDiv(50_000_000e8, 8_000, 10_000);
        borrowSats = bound(borrowSats, 1, Math.min(100 * B, Math.mulDiv(cap, 1e8, price)));
        _borrow(carol, cirbtc, borrowSats);
        uint256 debtValue = _ceil(borrowSats, price, 1e8);
        assertEq(pool.getAccountData(carol).borrowValueUsd, debtValue);
        assertEq(pool.getUserPosition(carol).totalDebtValueUsd, debtValue);
        // rounding direction: debt value never below, collateral value never above, the exact quotient
        assertGe(debtValue * 1e8, borrowSats * price);
        assertLe(value * 1e8, sats * price);
    }

    function testFuzz_MaxBorrowable_CirBtcCollateral_IsExact(uint256 sats, uint256 price, bool eurcDebt) public {
        sats = bound(sats, 1e5, 5e9);
        price = bound(price, 1_000e8, 500_000e8);
        _deposit(alice, usdc, 50_000_000 * M);
        _deposit(alice, eurc, 50_000_000 * M);
        _setBtcPrice(price);
        _deposit(bob, cirbtc, sats);
        MockERC20 t = eurcDebt ? eurc : usdc;
        uint256 m = pool.maxBorrowable(address(t), bob);
        assertGt(m, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        vm.expectRevert();
        pool.borrow(address(t), m + 1);
        vm.prank(bob);
        pool.borrow(address(t), m);
        vm.revertToState(snap);
        // the limit corresponds to <= 70% of the (floored) collateral value
        uint256 limit = Math.mulDiv(Math.mulDiv(sats, price, 1e8), 7_000, 10_000);
        assertLe(_ceil(m, pool.priceOf(address(t)), 1e6), limit);
        assertGt(_ceil(m + 1, pool.priceOf(address(t)), 1e6), limit);
    }

    function testFuzz_MaxBorrowable_CirBtcDebt_IsExact(uint256 collateral, uint256 price, bool eurcCol) public {
        collateral = bound(collateral, 100 * M, 1_000_000 * M);
        price = bound(price, 1_000e8, 5_000_000e8);
        _deposit(alice, cirbtc, 100 * B);
        _setBtcPrice(price);
        MockERC20 c = eurcCol ? eurc : usdc;
        _deposit(bob, c, collateral);
        uint256 m = pool.maxBorrowable(address(cirbtc), bob);
        if (m == 0) return;
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        vm.expectRevert();
        pool.borrow(address(cirbtc), m + 1);
        vm.prank(bob);
        pool.borrow(address(cirbtc), m);
        assertLe(pool.getAccountData(bob).borrowValueUsd, pool.getAccountData(bob).borrowLimitUsd);
        vm.revertToState(snap);
    }

    function testFuzz_MaxWithdrawable_CirBtcCollateral_IsExact(uint256 sats, uint256 price, uint256 frac) public {
        sats = bound(sats, 1e6, 5e9);
        price = bound(price, 10_000e8, 1_000_000e8);
        _deposit(alice, usdc, 50_000_000 * M);
        _setBtcPrice(price);
        _deposit(bob, cirbtc, sats);
        uint256 mb = pool.maxBorrowable(address(usdc), bob);
        _borrow(bob, usdc, bound(frac, 1, mb));
        uint256 m = pool.maxWithdrawable(address(cirbtc), bob);
        assertLt(m, sats); // some collateral must stay behind for any debt
        uint256 snap = vm.snapshotState();
        if (m > 0) _withdraw(bob, cirbtc, m);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(cirbtc), 1);
        vm.revertToState(snap);
        if (m + 1 <= sats) {
            vm.prank(bob);
            vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
            pool.withdraw(address(cirbtc), m + 1);
        }
    }

    // ================================================================ fuzz: liquidation never leaves the pool insolvent
    function _expSeized(address debtAsset, address colAsset, uint256 applied) internal view returns (uint256) {
        uint256 pd = pool.priceOf(debtAsset);
        uint256 pc = pool.priceOf(colAsset);
        uint256 bonus = pool.getReserveData(colAsset).liquidationBonus;
        // single floor-rounded computation (borrower-favourable)
        return Math.mulDiv(applied * pd * _u(colAsset), 10_000 + bonus, pc * _u(debtAsset) * 10_000);
    }

    function _liquidateAndCheck(address debtAsset, address colAsset, uint256 req) internal {
        uint256 debtBefore = pool.debtBalanceOf(debtAsset, bob);
        uint256 colBefore = pool.supplyBalanceOf(colAsset, bob);
        uint256 liqDebtBal = MockERC20(debtAsset).balanceOf(liq);
        uint256 liqColBal = MockERC20(colAsset).balanceOf(liq);
        uint256 closeFactor = pool.liquidationCloseFactor(bob); // 50%, or 100% when health < 0.95
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, debtAsset, colAsset, req);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();

        assertGt(repaid, 0);
        assertLe(repaid, req);
        assertLe(repaid, Math.mulDiv(debtBefore, closeFactor, 10_000)); // close factor
        assertEq(seized, _expSeized(debtAsset, colAsset, repaid)); // exact cross-decimal math, 8% / 5% bonus
        assertLe(seized, colBefore); // never more than the borrower holds
        assertEq(pool.debtBalanceOf(debtAsset, bob), debtBefore - repaid);
        assertEq(pool.supplyBalanceOf(colAsset, bob), colBefore - seized);
        assertEq(MockERC20(debtAsset).balanceOf(liq), liqDebtBal - repaid);
        if (paid) assertEq(MockERC20(colAsset).balanceOf(liq), liqColBal + seized);
        else assertEq(pool.supplyBalanceOf(colAsset, liq), seized);
        _assertAllSolvent();
    }

    function testFuzz_Liquidation_CirBtcCollateral(uint256 sats, uint256 newPrice, uint256 req, bool eurcDebt)
        public
    {
        sats = bound(sats, 1e5, 5e9);
        newPrice = bound(newPrice, 10_000e8, 93_000e8);
        _deposit(alice, usdc, 50_000_000 * M);
        _deposit(alice, eurc, 50_000_000 * M);
        _deposit(bob, cirbtc, sats);
        MockERC20 t = eurcDebt ? eurc : usdc;
        _borrow(bob, t, pool.maxBorrowable(address(t), bob));
        _setBtcPrice(newPrice);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        // below ~900 micro-USDC the floor seizure is zero (ZeroSeizure, covered in DustLiquidation tests)
        req = bound(req, 10_000, pool.debtBalanceOf(address(t), bob));
        _liquidateAndCheck(address(t), address(cirbtc), req);
    }

    function testFuzz_Liquidation_CirBtcDebt(uint256 collateral, uint256 newPrice, uint256 req, bool eurcCol) public {
        collateral = bound(collateral, 100 * M, 1_000_000 * M);
        newPrice = bound(newPrice, 110_000e8, 100_000_000e8);
        _deposit(alice, cirbtc, 100 * B);
        _deposit(alice, usdc, 50_000_000 * M);
        _deposit(alice, eurc, 50_000_000 * M);
        MockERC20 c = eurcCol ? eurc : usdc;
        _deposit(bob, c, collateral);
        _borrow(bob, cirbtc, pool.maxBorrowable(address(cirbtc), bob));
        _setBtcPrice(newPrice);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        req = bound(req, 1, pool.debtBalanceOf(address(cirbtc), bob));
        _liquidateAndCheck(address(cirbtc), address(c), req);
    }

    function testFuzz_Liquidation_AfterInterest_CirBtcCollateral(uint256 sats, uint256 elapsed, uint256 newPrice)
        public
    {
        sats = bound(sats, 1e6, 5e9);
        elapsed = bound(elapsed, 1 hours, 300 days);
        newPrice = bound(newPrice, 20_000e8, 80_000e8);
        _deposit(alice, usdc, 50_000_000 * M);
        _deposit(bob, cirbtc, sats);
        _borrow(bob, usdc, pool.maxBorrowable(address(usdc), bob));
        skip(elapsed);
        _setUsdcPrice(USDC_PRICE);
        _refreshEurc();
        _setBtcPrice(newPrice);
        uint256 debt = pool.debtBalanceOf(address(usdc), bob);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        uint256 debtBefore = debt;
        uint256 colBefore = pool.supplyBalanceOf(address(cirbtc), bob);
        uint256 closeFactor = pool.liquidationCloseFactor(bob); // 50%, or 100% when health < 0.95
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), debt);
        (uint256 repaid, uint256 seized,) = _lastLiquidation();
        assertLe(repaid, Math.mulDiv(debtBefore, closeFactor, 10_000));
        assertLe(seized, colBefore);
        assertEq(seized, _expSeized(address(usdc), address(cirbtc), repaid));
        _assertAllSolvent();
    }
}
