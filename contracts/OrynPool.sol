// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/**
 * @title OrynPool
 * @notice Three-reserve, cross-collateral money market intended for Arc Testnet (5042002).
 * @dev Immutable USDC, EURC and cirBTC use per-asset decimals (at most 18), read once at construction.
 * Expected testnet assets: USDC 0x3600000000000000000000000000000000000000,
 * EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a and
 * cirBTC 0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF (8 decimals).
 * Addresses are constructor inputs. All USD prices are read from immutable
 * Chainlink-compatible AggregatorV3 feeds: USDC/USD, EURC/USD and BTC/USD.
 * On Arc Testnet the EURC feed is a testnet-only mirror of the Arc mainnet Chainlink EURC/USD
 * answer (proxy 0x361b95c10b76Ca3f35C686d423e43A951755Bf23, 8 decimals, 24h heartbeat),
 * preserving Chainlink's original update timestamp rather than the relay timestamp.
 * Oracle price views are indicative even when stale; borrowing, liquidation and
 * withdrawals with debt enforce freshness. Deposits, repayment and debt-free exits
 * do not read the feed.
 *
 * Balances use fixed-origin 1e18 indexes, not cash/share exchange rates. Donations never
 * increase an index, so the first depositor cannot inflate the share price by donating.
 * Rounding surplus and unsolicited donations belong to explicit protocol reserves.
 * Aggregate indexed supplier claims = cash + aggregate indexed debt - reserves.
 * Individual rounded balances can differ from aggregate balances by rounding dust.
 * Interest compounds between interactions, linearly within each elapsed interval.
 *
 * There is no bad-debt write-off or loss socialization: uncollateralized debt remains
 * outstanding, may earn unrealizable interest, and can prevent suppliers from exiting.
 * Accounting deficits revert explicitly rather than underflowing. Rebasing and tokens
 * charging transfer fees are unsupported: incoming receipts must equal the requested
 * amount. All three configured assets must be standard ERC-20 tokens.
 */
contract OrynPool is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Fixed-origin indexes use 18 decimals; retained RAY name preserves the existing API.
    uint256 public constant RAY = 1e18;
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant CLOSE_FACTOR = 5_000;
    uint256 public constant RESERVE_FACTOR = 1_000;
    uint256 public constant OPTIMAL_UTILIZATION = 0.8e18;
    uint256 public constant BASE_RATE = 0;
    uint256 public constant SLOPE1 = 0.04e18;
    uint256 public constant SLOPE2 = 0.56e18;
    uint256 public constant PRICE_UPDATE_DELAY = 6 hours;
    uint256 public constant PRICE_UPDATE_EXPIRY = 3 days;

    address public immutable USDC;
    address public immutable EURC;
    address public immutable CIRBTC;
    uint256 public immutable usdcUnit;
    uint256 public immutable eurcUnit;
    uint256 public immutable cirBtcUnit;
    AggregatorV3Interface public immutable usdcUsdFeed;
    AggregatorV3Interface public immutable eurcUsdFeed;
    AggregatorV3Interface public immutable btcUsdFeed;
    uint8 public immutable usdcFeedDecimals;
    uint8 public immutable feedDecimals;
    uint8 public immutable btcFeedDecimals;
    uint256 public maxPriceAge = 2 days;

    struct Reserve {
        uint256 supplyIndex;
        uint256 borrowIndex;
        uint256 scaledSupply;
        uint256 scaledDebt;
        uint256 protocolReserves;
        uint256 lastUpdate;
        uint256 supplyCap;
        uint256 borrowCap;
        uint256 ltv;
        uint256 liquidationThreshold;
        uint256 liquidationBonus;
    }

    struct PendingRiskParams {
        uint256 ltv;
        uint256 liquidationThreshold;
        uint256 liquidationBonus;
        uint256 supplyCap;
        uint256 borrowCap;
        uint256 eta;
    }

    struct Snapshot {
        uint256 supplyIndex;
        uint256 borrowIndex;
        uint256 totalSupplied;
        uint256 totalBorrowed;
        uint256 cash;
        uint256 protocolReserves;
    }

    struct ReserveData {
        uint256 totalSupplied;
        uint256 totalBorrowed;
        uint256 availableLiquidity;
        uint256 utilization;
        uint256 supplyRateApr;
        uint256 borrowRateApr;
        uint256 supplyCap;
        uint256 borrowCap;
        uint256 ltv;
        uint256 liquidationThreshold;
        uint256 liquidationBonus;
        uint256 price8;
    }

    struct Account {
        uint256 collateral;
        uint256 debt;
        uint256 capacity;
        uint256 liquidationValue;
    }

    /// @notice Amounts use each token's decimals, USD values 8, APR and health factors 18.
    struct MarketData {
        uint256 totalSupply;
        uint256 totalBorrows;
        uint256 availableLiquidity;
        uint256 supplyAprWad;
        uint256 borrowAprWad;
        uint256 utilizationWad;
        uint256 supplyCap;
        uint256 borrowCap;
        uint256 collateralFactorBps;
        uint256 liquidationThresholdBps;
    }

    /// @dev Arrays use index 0 = USDC, 1 = EURC, 2 = cirBTC. Totals are USD, not mixed currencies.
    struct UserPosition {
        uint256[3] supplyBalances;
        uint256[3] debtBalances;
        uint256 totalSupplyValueUsd;
        uint256 totalDebtValueUsd;
    }

    struct AccountData {
        uint256 collateralValueUsd;
        uint256 borrowValueUsd;
        uint256 borrowLimitUsd;
        uint256 liquidationLimitUsd;
        uint256 healthFactorWad;
        uint256[3] maxBorrow;
    }

    struct LiquidationQuote {
        uint256 collateralShares;
        uint256 collateral;
        uint256 maximumRepay;
        uint256 seizureNumerator;
        uint256 seizureDenominator;
    }

    struct BorrowContext {
        uint256 oldShares;
        uint256 price;
        uint256 unit;
        uint256 budget;
        uint256 high;
    }

    struct WithdrawalContext {
        uint256 shares;
        uint256 balance;
        uint256 supplyIndex;
        uint256 ltv;
        uint256 price;
        uint256 requiredCapacity;
    }

    mapping(address asset => Reserve) private _reserves;
    mapping(address asset => PendingRiskParams) private _pendingRiskParams;
    mapping(address asset => mapping(address user => uint256)) public scaledSupplyOf;
    mapping(address asset => mapping(address user => uint256)) public scaledDebtOf;

    error ZeroAddress();
    error IdenticalAssets();
    error UnsupportedAsset(address asset);
    error UnsupportedDecimals(address asset, uint8 decimals);
    error ZeroAmount();
    error ZeroShares();
    error ZeroSeizure();
    error InvalidRiskParams();
    error NoPendingRiskParams();
    error RiskParamsNotReady();
    error RiskParamsExpired();
    error InvalidPrice();
    error OwnershipRenunciationDisabled();
    error InvalidMaxPriceAge();
    error StalePrice(uint256 updatedAt, uint256 maximumAge);
    error SupplyCapExceeded();
    error BorrowCapExceeded();
    error InsufficientSupply();
    error InsufficientLiquidity(address asset, uint256 requested, uint256 available);
    error InsufficientBorrowCapacity();
    error NotLiquidatable();
    error InsufficientReserves();
    error InvalidRecipient();
    error UnsupportedTokenBehavior();
    error AccountingDeficit(address asset);

    event Deposit(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Withdraw(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Borrow(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Repay(address indexed user, address indexed payer, address indexed asset, uint256 amount, uint256 shares);
    event Liquidation(address indexed liquidator, address indexed borrower, address indexed debtAsset,
        address collateralAsset, uint256 repaid, uint256 seized, bool paidUnderlying);
    event ParamsUpdated(address indexed asset, uint256 ltv, uint256 liquidationThreshold,
        uint256 liquidationBonus, uint256 supplyCap, uint256 borrowCap);
    event RiskParamsQueued(address indexed asset, uint256 ltv, uint256 liquidationThreshold,
        uint256 liquidationBonus, uint256 supplyCap, uint256 borrowCap, uint256 eta);
    event RiskParamsCancelled(address indexed asset);
    event MaxPriceAgeUpdated(uint256 maximumAge);
    event ReservesCollected(address indexed asset, address indexed to, uint256 amount);
    event Accrued(address indexed asset, uint256 supplyIndex, uint256 borrowIndex,
        uint256 protocolReserves, uint256 timestamp);
    event ReservesSynced(address indexed asset, uint256 protocolReserves);
    event UnrelatedTokenRescued(address indexed token, address indexed to, uint256 amount);

    /// @param initialOwner Owner using two-step ownership transfers.
    /// @param usdc USDC; market index zero.
    /// @param eurc EURC; market index one.
    /// @param cirBtc Circle wrapped Bitcoin; market index two.
    /// @param usdcUsdFeed_ Chainlink-compatible USDC/USD feed.
    /// @param eurcUsdFeed_ Chainlink-compatible EURC/USD feed; use a mirror on Arc Testnet.
    /// @param btcUsdFeed_ Chainlink-compatible BTC/USD feed.
    /// @dev Reads each token's decimals once and feed decimals; initial rounds are not required.
    constructor(address initialOwner, address usdc, address eurc, address cirBtc,
        address usdcUsdFeed_, address eurcUsdFeed_, address btcUsdFeed_)
        Ownable(initialOwner)
    {
        if (usdc == address(0) || eurc == address(0) || cirBtc == address(0) || initialOwner == address(0)
            || usdcUsdFeed_ == address(0) || eurcUsdFeed_ == address(0) || btcUsdFeed_ == address(0)) {
            revert ZeroAddress();
        }
        if (usdc == eurc || usdc == cirBtc || eurc == cirBtc) revert IdenticalAssets();
        USDC = usdc;
        EURC = eurc;
        CIRBTC = cirBtc;
        usdcUnit = _readUnit(usdc);
        eurcUnit = _readUnit(eurc);
        cirBtcUnit = _readUnit(cirBtc);
        usdcUsdFeed = AggregatorV3Interface(usdcUsdFeed_);
        eurcUsdFeed = AggregatorV3Interface(eurcUsdFeed_);
        btcUsdFeed = AggregatorV3Interface(btcUsdFeed_);
        uint8[3] memory decimals_;
        decimals_[0] = AggregatorV3Interface(usdcUsdFeed_).decimals();
        decimals_[1] = AggregatorV3Interface(eurcUsdFeed_).decimals();
        decimals_[2] = AggregatorV3Interface(btcUsdFeed_).decimals();
        if (decimals_[0] > 18 || decimals_[1] > 18 || decimals_[2] > 18) revert InvalidPrice();
        usdcFeedDecimals = decimals_[0];
        feedDecimals = decimals_[1];
        btcFeedDecimals = decimals_[2];
        _initialize(usdc, 8_000, 8_500, 500);
        _initialize(eurc, 7_500, 8_000, 500);
        _initialize(cirBtc, 7_000, 7_500, 800);
    }

    function _readUnit(address asset) private view returns (uint256) {
        uint8 decimals_ = IERC20Metadata(asset).decimals();
        if (decimals_ > 18) revert UnsupportedDecimals(asset, decimals_);
        return 10 ** uint256(decimals_);
    }

    function _initialize(address asset, uint256 ltv, uint256 threshold, uint256 bonus) private {
        _validateRiskParams(ltv, threshold, bonus);
        Reserve storage r = _reserves[asset];
        r.supplyIndex = RAY;
        r.borrowIndex = RAY;
        r.lastUpdate = block.timestamp;
        r.ltv = ltv;
        r.liquidationThreshold = threshold;
        r.liquidationBonus = bonus;
        emit ParamsUpdated(asset, ltv, threshold, bonus, 0, 0);
    }

    /// @notice Deposits automatically collateralize all three markets. Deposits stay open while paused so
    ///         borrowers can top up collateral; only new borrowing is frozen by the pause.
    function deposit(address asset, uint256 amount) external nonReentrant {
        _requireAsset(asset);
        if (amount == 0) revert ZeroAmount();
        _accrueAll();
        Reserve storage r = _reserves[asset];
        uint256 supplied = Math.mulDiv(r.scaledSupply, r.supplyIndex, RAY);
        if (r.supplyCap != 0 && supplied + amount > r.supplyCap) revert SupplyCapExceeded();
        uint256 shares = Math.mulDiv(amount, RAY, r.supplyIndex);
        if (shares == 0) revert ZeroShares();
        scaledSupplyOf[asset][msg.sender] += shares;
        r.scaledSupply += shares;
        _receive(asset, msg.sender, amount);
        _syncReserves(asset);
        emit Deposit(msg.sender, asset, amount, shares);
    }

    /// @notice Debt-free withdrawals work while paused or stale; MAX withdraws the rounded-down balance.
    /// @dev Outstanding debt requires a fresh oracle and the stricter LTV check, not LT.
    function withdraw(address asset, uint256 amount) external nonReentrant {
        _requireAsset(asset);
        _accrueAll();
        Reserve storage r = _reserves[asset];
        uint256 userShares = scaledSupplyOf[asset][msg.sender];
        uint256 balance = Math.mulDiv(userShares, r.supplyIndex, RAY);
        if (amount == type(uint256).max) amount = balance;
        if (amount == 0) revert ZeroAmount();
        if (amount > balance) revert InsufficientSupply();
        _requireLiquidity(asset, amount);
        uint256 shares = amount == balance ? userShares : _up(amount, RAY, r.supplyIndex);
        scaledSupplyOf[asset][msg.sender] = userShares - shares;
        r.scaledSupply -= shares;
        if (_hasDebt(msg.sender)) {
            _requireNotPaused();
            _requireFreshPrice();
            Account memory a = _currentAccount(msg.sender);
            if (a.debt > a.capacity) revert InsufficientBorrowCapacity();
        }
        _send(asset, msg.sender, amount);
        _syncReserves(asset);
        emit Withdraw(msg.sender, asset, amount, shares);
    }

    function borrow(address asset, uint256 amount) external nonReentrant whenNotPaused {
        _requireAsset(asset);
        if (amount == 0) revert ZeroAmount();
        _requireFreshPrice();
        _accrueAll();
        _requireLiquidity(asset, amount);
        Reserve storage r = _reserves[asset];
        uint256 shares = _up(amount, RAY, r.borrowIndex);
        scaledDebtOf[asset][msg.sender] += shares;
        r.scaledDebt += shares;
        if (r.borrowCap != 0 && _up(r.scaledDebt, r.borrowIndex, RAY) > r.borrowCap) {
            revert BorrowCapExceeded();
        }
        Account memory a = _currentAccount(msg.sender);
        if (a.debt > a.capacity) revert InsufficientBorrowCapacity();
        _send(asset, msg.sender, amount);
        _syncReserves(asset);
        emit Borrow(msg.sender, asset, amount, shares);
    }

    /// @notice Always available while paused or stale. MAX attempts to repay all debt.
    /// @dev Burns debt shares down and rounds the underlying charge up; pulls only the applied amount.
    function repay(address asset, uint256 amount) external nonReentrant {
        _requireAsset(asset);
        if (amount == 0) revert ZeroAmount();
        _accrueAll();
        _repay(asset, msg.sender, amount);
    }

    /// @notice Repays at most 50% of the chosen debt when liquidation HF is below one.
    /// @dev Pays seized underlying when cash suffices, otherwise transfers scaled supply shares.
    /// Same-asset liquidation includes incoming repayment in available cash. Seizure is
    /// capped by the borrower's collateral and the repayment is reduced accordingly.
    function liquidate(address borrower, address debtAsset, address collateralAsset, uint256 repayAmount)
        external nonReentrant
    {
        if (borrower == address(0)) revert ZeroAddress();
        _requireAsset(debtAsset);
        _requireAsset(collateralAsset);
        if (repayAmount == 0) revert ZeroAmount();
        _requireFreshPrice();
        _accrueAll();
        Account memory a = _currentAccount(borrower);
        if (a.debt == 0 || a.debt <= a.liquidationValue) revert NotLiquidatable();
        LiquidationQuote memory q = _liquidationQuote(borrower, debtAsset, collateralAsset);
        uint256 applied = _repay(debtAsset, borrower, Math.min(repayAmount, q.maximumRepay));
        uint256 seized = Math.mulDiv(applied, q.seizureNumerator, q.seizureDenominator);
        if (seized == 0) revert ZeroSeizure();
        bool paidUnderlying = _applyLiquidationCollateral(borrower, collateralAsset, seized, q);
        emit Liquidation(msg.sender, borrower, debtAsset, collateralAsset, applied, seized, paidUnderlying);
    }

    function _liquidationQuote(address borrower, address debtAsset, address collateralAsset)
        private view returns (LiquidationQuote memory q)
    {
        Reserve storage c = _reserves[collateralAsset];
        q.collateralShares = scaledSupplyOf[collateralAsset][borrower];
        q.collateral = Math.mulDiv(q.collateralShares, c.supplyIndex, RAY);
        if (q.collateral == 0) revert InsufficientSupply();
        // These constant factors fit uint256 for supported prices (<= ~1e16),
        // token units (<= 1e18) and bonuses (<= 1_000). No division rounds them.
        q.seizureNumerator = _price(debtAsset) * _unit(collateralAsset) * (BPS + c.liquidationBonus);
        q.seizureDenominator = _price(collateralAsset) * _unit(debtAsset) * BPS;
        uint256 debt = _up(scaledDebtOf[debtAsset][borrower], _reserves[debtAsset].borrowIndex, RAY);
        q.maximumRepay = _maximumLiquidationRepay(q, Math.mulDiv(debt, CLOSE_FACTOR, BPS));
    }

    /// @dev Largest x <= closeLimit with floor(x * numerator / denominator) <= collateral.
    /// Invert the strict bound x * numerator < (collateral + 1) * denominator.
    function _maximumLiquidationRepay(LiquidationQuote memory q, uint256 closeLimit)
        private pure returns (uint256)
    {
        uint256 numerator = q.seizureNumerator;
        uint256 denominator = q.seizureDenominator;
        // When numerator <= denominator this forward result cannot overflow. If
        // it does not fit, the inverse below is strictly less than closeLimit.
        if (numerator <= denominator
            && Math.mulDiv(closeLimit, numerator, denominator) <= q.collateral) return closeLimit;
        uint256 limit = Math.mulDiv(q.collateral, denominator, numerator);
        // Split (collateral + 1) * denominator without overflowing collateral + 1.
        // Only constant-sized remainders are added; their sum fits supported ranges.
        uint256 tail = mulmod(q.collateral, denominator, numerator) + denominator;
        limit += tail / numerator;
        // The inverse bound is strict: an exact boundary needs one downward step.
        if (tail % numerator == 0) limit -= 1;
        return Math.min(limit, closeLimit);
    }

    /// @dev Token units are powers of ten, so cancel them before the full-precision mulDiv.
    /// A single rounding step preserves the exact inverse used by maximumRepay.
    function _convertAssetAmount(uint256 amount, address fromAsset, address toAsset, Math.Rounding rounding)
        private view returns (uint256)
    {
        uint256 fromUnit = _unit(fromAsset);
        uint256 toUnit = _unit(toAsset);
        uint256 fromPrice = _price(fromAsset);
        uint256 toPrice = _price(toAsset);
        if (toUnit >= fromUnit) {
            uint256 scale = toUnit / fromUnit;
            uint256 quotient = Math.mulDiv(amount, fromPrice, toPrice);
            uint256 remainder = mulmod(amount, fromPrice, toPrice);
            return quotient * scale + Math.mulDiv(remainder, scale, toPrice, rounding);
        }
        return _mulDivScaleDown(amount, fromPrice, toPrice, fromUnit / toUnit, rounding);
    }

    /// @dev Exact amount * price / (denominator * scale), without multiplying the denominator.
    /// Scale is a token-unit ratio, at most 1e18; tail is therefore at most 2e18 - 2.
    function _mulDivScaleDown(uint256 amount, uint256 price, uint256 denominator, uint256 scale,
        Math.Rounding rounding) private pure returns (uint256 result)
    {
        uint256 whole = amount / denominator;
        uint256 remainder = amount % denominator;
        result = Math.mulDiv(whole, price, scale);
        uint256 fractional = Math.mulDiv(remainder, price, denominator);
        uint256 tail = mulmod(whole, price, scale) + fractional % scale;
        result += fractional / scale + tail / scale;
        if (rounding == Math.Rounding.Ceil
            && (tail % scale != 0 || mulmod(remainder, price, denominator) != 0)) {
            result += 1;
        }
    }

    function _applyLiquidationCollateral(address borrower, address collateralAsset, uint256 seized,
        LiquidationQuote memory q) private returns (bool paidUnderlying)
    {
        Reserve storage c = _reserves[collateralAsset];
        paidUnderlying = IERC20(collateralAsset).balanceOf(address(this)) >= seized;
        uint256 shares;
        if (paidUnderlying) {
            shares = seized == q.collateral ? q.collateralShares : _up(seized, RAY, c.supplyIndex);
        } else {
            // Round transferred claims down so the liquidator receives no excess supply claim.
            shares = Math.mulDiv(seized, RAY, c.supplyIndex);
            if (shares == 0) revert ZeroSeizure();
        }
        if (shares > q.collateralShares) revert InsufficientSupply();
        scaledSupplyOf[collateralAsset][borrower] = q.collateralShares - shares;
        if (paidUnderlying) {
            c.scaledSupply -= shares;
            _send(collateralAsset, msg.sender, seized);
        } else {
            scaledSupplyOf[collateralAsset][msg.sender] += shares;
        }
        _syncReserves(collateralAsset);
    }

    /// @notice Queues risk parameters for an asset without changing its current parameters.
    /// @dev Replaces any proposal for that asset with a new 6-hour delay; the owner must apply it
    /// within 3 days after its ETA. Constructor initialization still sets initial parameters immediately.
    function setRiskParams(address asset, uint256 ltv, uint256 liquidationThreshold,
        uint256 liquidationBonus, uint256 supplyCap, uint256 borrowCap)
        external onlyOwner nonReentrant
    {
        _requireAsset(asset);
        _validateRiskParams(ltv, liquidationThreshold, liquidationBonus);
        uint256 eta = block.timestamp + PRICE_UPDATE_DELAY;
        _pendingRiskParams[asset] = PendingRiskParams({
            ltv: ltv,
            liquidationThreshold: liquidationThreshold,
            liquidationBonus: liquidationBonus,
            supplyCap: supplyCap,
            borrowCap: borrowCap,
            eta: eta
        });
        emit RiskParamsQueued(asset, ltv, liquidationThreshold, liquidationBonus, supplyCap, borrowCap, eta);
    }

    /// @notice Applies an asset's queued risk parameters after the delay and within 3 days of its ETA.
    /// @dev Accrues all three markets before updating the reserve and clears the applied proposal.
    function applyPendingRiskParams(address asset) external onlyOwner nonReentrant {
        PendingRiskParams memory pending = _pendingRiskParams[asset];
        if (pending.eta == 0) revert NoPendingRiskParams();
        if (block.timestamp < pending.eta) revert RiskParamsNotReady();
        if (block.timestamp > pending.eta + PRICE_UPDATE_EXPIRY) revert RiskParamsExpired();
        _accrueAll();
        Reserve storage r = _reserves[asset];
        r.ltv = pending.ltv;
        r.liquidationThreshold = pending.liquidationThreshold;
        r.liquidationBonus = pending.liquidationBonus;
        r.supplyCap = pending.supplyCap;
        r.borrowCap = pending.borrowCap;
        emit ParamsUpdated(asset, pending.ltv, pending.liquidationThreshold, pending.liquidationBonus,
            pending.supplyCap, pending.borrowCap);
        delete _pendingRiskParams[asset];
    }

    /// @notice Clears an asset's queued risk parameters without changing its current parameters.
    function cancelPendingRiskParams(address asset) external onlyOwner {
        delete _pendingRiskParams[asset];
        emit RiskParamsCancelled(asset);
    }

    /// @notice Returns an asset's pending risk parameters and ETA; all are zero if no proposal exists.
    function pendingRiskParams(address asset) public view returns (uint256 ltv, uint256 liquidationThreshold,
        uint256 liquidationBonus, uint256 supplyCap, uint256 borrowCap, uint256 eta)
    {
        PendingRiskParams storage pending = _pendingRiskParams[asset];
        return (pending.ltv, pending.liquidationThreshold, pending.liquidationBonus,
            pending.supplyCap, pending.borrowCap, pending.eta);
    }

    function _validateRiskParams(uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)
        private pure
    {
        if (ltv >= liquidationThreshold || liquidationThreshold > 9_500 || liquidationBonus > 1_000) {
            revert InvalidRiskParams();
        }
    }

    function setMaxPriceAge(uint256 maximumAge) external onlyOwner nonReentrant {
        if (maximumAge < 1 hours || maximumAge > 7 days) revert InvalidMaxPriceAge();
        _accrueAll();
        maxPriceAge = maximumAge;
        emit MaxPriceAgeUpdated(maximumAge);
    }

    /// @notice Collect only protocol equity, never supplier claims; cash may limit collection.
    function collectReserves(address asset, address to, uint256 amount) external onlyOwner nonReentrant {
        _requireAsset(asset);
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        _accrueAll();
        Reserve storage r = _reserves[asset];
        if (amount > r.protocolReserves) revert InsufficientReserves();
        _requireLiquidity(asset, amount);
        r.protocolReserves -= amount;
        _send(asset, to, amount);
        _syncReserves(asset);
        emit ReservesCollected(asset, to, amount);
    }

    /// @notice Initiates a two-step transfer, accruing all three markets first.
    function transferOwnership(address newOwner) public override onlyOwner nonReentrant {
        if (newOwner == address(0)) revert ZeroAddress();
        _accrueAll();
        super.transferOwnership(newOwner);
    }

    /// @notice The pending owner completes the two-step transfer.
    function acceptOwnership() public override nonReentrant {
        if (pendingOwner() != msg.sender) revert OwnableUnauthorizedAccount(msg.sender);
        _accrueAll();
        super.acceptOwnership();
    }

    /// @notice Ownership must remain transferable via Ownable2Step, never renounced.
    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    /// @notice Pauses new borrowing; deposits, repay and liquidate remain available.
    /// @dev Withdrawals retain existing health/liquidity checks; only debt-free withdrawals bypass pause.
    function pause() external onlyOwner nonReentrant {
        _accrueAll();
        _pause();
    }

    function unpause() external onlyOwner nonReentrant {
        _accrueAll();
        _unpause();
    }

    /// @notice Materializes interest for one market, including while paused.
    function accrue(address token) external nonReentrant {
        _requireAsset(token);
        _accrue(token);
    }

    /// @notice Rescues only tokens unrelated to the three immutable markets.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (token == USDC || token == EURC || token == CIRBTC || to == address(this)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        _accrueAll();
        IERC20(token).safeTransfer(to, amount);
        emit UnrelatedTokenRescued(token, to, amount);
    }

    /// @notice Returns the current eight-decimal USDC/USD quote, even if stale.
    function usdcUsdPrice() public view returns (uint256) {
        (bool valid, uint256 price8,) = _readFeed(usdcUsdFeed, usdcFeedDecimals);
        if (!valid) revert InvalidPrice();
        return price8;
    }

    /// @notice Returns the current eight-decimal EURC/USD quote, even if stale.
    function eurUsdPrice() public view returns (uint256) {
        (bool valid, uint256 price8,) = _readFeed(eurcUsdFeed, feedDecimals);
        if (!valid) revert InvalidPrice();
        return price8;
    }

    /// @notice Returns the current eight-decimal BTC/USD quote, even if stale.
    function btcUsdPrice() public view returns (uint256) {
        (bool valid, uint256 price8,) = _readFeed(btcUsdFeed, btcFeedDecimals);
        if (!valid) revert InvalidPrice();
        return price8;
    }

    /// @notice Returns the BTC source timestamp, or zero if its round cannot be read.
    function btcPriceUpdatedAt() public view returns (uint256) {
        (,, uint256 updatedAt) = _readFeed(btcUsdFeed, btcFeedDecimals);
        return updatedAt;
    }

    /// @notice Compatibility alias for eurUsdPrice(); indicative even if stale.
    function eurcUsdPrice() external view returns (uint256) {
        return eurUsdPrice();
    }

    /// @notice Returns the USDC source timestamp, or zero if its round cannot be read.
    function usdcPriceUpdatedAt() public view returns (uint256) {
        (,, uint256 updatedAt) = _readFeed(usdcUsdFeed, usdcFeedDecimals);
        return updatedAt;
    }

    /// @notice Returns the oldest source timestamp, or zero if any round cannot be read.
    function priceUpdatedAt() public view returns (uint256) {
        (, uint256 oldestUpdatedAt) = _priceFreshness();
        return oldestUpdatedAt;
    }

    function priceFeed() external view returns (address) {
        return address(eurcUsdFeed);
    }

    /// @notice Indicates whether all three configured feed quotes are fresh for risk-increasing actions.
    function isPriceFresh() external view returns (bool) {
        return !_isStale();
    }

    /// @notice Returns live indexed market balances and current annualized rates.
    function getMarket(address token) external view returns (MarketData memory d) {
        Snapshot memory s = _preview(token);
        Reserve storage r = _reserves[token];
        d.totalSupply = s.totalSupplied;
        d.totalBorrows = s.totalBorrowed;
        d.availableLiquidity = s.cash;
        d.utilizationWad = _utilization(s.totalBorrowed, s.cash);
        d.borrowAprWad = _rate(d.utilizationWad);
        d.supplyAprWad = _supplyRate(d.borrowAprWad, d.utilizationWad);
        d.supplyCap = r.supplyCap;
        d.borrowCap = r.borrowCap;
        d.collateralFactorBps = r.ltv;
        d.liquidationThresholdBps = r.liquidationThreshold;
    }

    /// @notice Balances include pending interest; arrays use USDC, EURC, then cirBTC.
    /// @dev USD totals are indicative when the oracle is stale.
    function getUserPosition(address user) external view returns (UserPosition memory p) {
        if (user == address(0)) revert ZeroAddress();
        for (uint256 i; i < 3; ++i) {
            address token = _assetAt(i);
            Snapshot memory s = _preview(token);
            p.supplyBalances[i] = Math.mulDiv(scaledSupplyOf[token][user], s.supplyIndex, RAY);
            p.debtBalances[i] = _up(scaledDebtOf[token][user], s.borrowIndex, RAY);
            p.totalSupplyValueUsd += Math.mulDiv(p.supplyBalances[i], _price(token), _unit(token));
            p.totalDebtValueUsd += _up(p.debtBalances[i], _price(token), _unit(token));
        }
    }

    /// @notice USD totals use eight decimals; maxBorrow uses each token's native units.
    /// @dev Health uses liquidation thresholds; borrow limits use collateral factors.
    function getAccountData(address user) external view returns (AccountData memory d) {
        if (user == address(0)) revert ZeroAddress();
        Account memory a = _previewAccount(user);
        d.collateralValueUsd = a.collateral;
        d.borrowValueUsd = a.debt;
        d.borrowLimitUsd = a.capacity;
        d.liquidationLimitUsd = a.liquidationValue;
        d.healthFactorWad = a.debt == 0 ? type(uint256).max : Math.mulDiv(a.liquidationValue, WAD, a.debt);
        for (uint256 i; i < 3; ++i) {
            d.maxBorrow[i] = maxBorrowable(_assetAt(i), user);
        }
    }

    /// @notice Simulates exact debt rounding for an additional borrow, without changing state.
    /// @return healthFactorAfterWad Liquidation-threshold-based HF after the hypothetical borrow.
    /// @return withinBorrowLimit Whether LTV permits it; cash, cap, freshness and pause are separate checks.
    /// @dev Indicative even when stale; this does not assert that the borrow will execute.
    function previewBorrowLimit(address user, address token, uint256 amount)
        external view returns (uint256 healthFactorAfterWad, bool withinBorrowLimit)
    {
        if (user == address(0)) revert ZeroAddress();
        Snapshot memory s = _preview(token);
        Account memory a = _previewAccount(user);
        uint256 shares = scaledDebtOf[token][user];
        uint256 debtAfter = a.debt - _debtValue(shares, s.borrowIndex, _price(token), _unit(token))
            + _debtValue(shares + _up(amount, RAY, s.borrowIndex), s.borrowIndex, _price(token), _unit(token));
        healthFactorAfterWad = debtAfter == 0 ? type(uint256).max : Math.mulDiv(a.liquidationValue, WAD, debtAfter);
        withinBorrowLimit = debtAfter <= a.capacity;
    }

    function assets() external view returns (address usdc, address eurc, address cirBtc) {
        return (USDC, EURC, CIRBTC);
    }

    function priceOf(address asset) external view returns (uint256 price8) {
        _requireAsset(asset);
        return _price(asset);
    }

    function supplyBalanceOf(address asset, address user) external view returns (uint256) {
        Snapshot memory s = _preview(asset);
        return Math.mulDiv(scaledSupplyOf[asset][user], s.supplyIndex, RAY);
    }

    function debtBalanceOf(address asset, address user) external view returns (uint256) {
        Snapshot memory s = _preview(asset);
        return _up(scaledDebtOf[asset][user], s.borrowIndex, RAY);
    }

    function getReserveData(address asset) external view returns (ReserveData memory d) {
        Snapshot memory s = _preview(asset);
        Reserve storage r = _reserves[asset];
        d.totalSupplied = s.totalSupplied;
        d.totalBorrowed = s.totalBorrowed;
        d.availableLiquidity = s.cash;
        d.utilization = _utilization(s.totalBorrowed, s.cash);
        d.borrowRateApr = _rate(d.utilization);
        d.supplyRateApr = _supplyRate(d.borrowRateApr, d.utilization);
        d.supplyCap = r.supplyCap;
        d.borrowCap = r.borrowCap;
        d.ltv = r.ltv;
        d.liquidationThreshold = r.liquidationThreshold;
        d.liquidationBonus = r.liquidationBonus;
        d.price8 = _price(asset);
    }

    function borrowRate(address asset) external view returns (uint256) {
        Snapshot memory s = _preview(asset);
        return _rate(_utilization(s.totalBorrowed, s.cash));
    }

    function supplyRate(address asset) external view returns (uint256) {
        Snapshot memory s = _preview(asset);
        uint256 utilization = _utilization(s.totalBorrowed, s.cash);
        return _supplyRate(_rate(utilization), utilization);
    }

    /// @notice Preview of explicit reserves, including interest, rounding surplus and donations.
    function protocolReservesOf(address asset) external view returns (uint256) {
        return _preview(asset).protocolReserves;
    }

    function getUserAccount(address user) external view returns (uint256 collateralValueUsd8,
        uint256 debtValueUsd8, uint256 borrowCapacityUsd8, uint256 liquidationValueUsd8, uint256 healthFactorWad)
    {
        Account memory a = _previewAccount(user);
        return (a.collateral, a.debt, a.capacity, a.liquidationValue,
            a.debt == 0 ? type(uint256).max : Math.mulDiv(a.liquidationValue, WAD, a.debt));
    }

    /// @notice Exact rounding-aware upper limit; returns zero when paused or oracle stale.
    function maxBorrowable(address asset, address user) public view returns (uint256) {
        _requireAsset(asset);
        if (paused() || _isStale()) return 0;
        Snapshot memory s = _preview(asset);
        BorrowContext memory c;
        c.oldShares = scaledDebtOf[asset][user];
        c.price = _price(asset);
        c.unit = _unit(asset);
        {
            Account memory a = _previewAccount(user);
            if (a.debt >= a.capacity) return 0;
            c.budget = a.capacity - (a.debt - _debtValue(c.oldShares, s.borrowIndex, c.price, c.unit));
        }
        c.high = Math.min(s.cash, Math.mulDiv(c.budget, c.unit, c.price));
        Reserve storage r = _reserves[asset];
        if (r.borrowCap != 0) {
            if (s.totalBorrowed >= r.borrowCap) return 0;
            c.high = Math.min(c.high, r.borrowCap - s.totalBorrowed);
        }
        return _borrowLimit(r, s, c);
    }

    /// @dev Monotonic binary search accounts for debt-share and USD rounding and cap dust.
    function _borrowLimit(Reserve storage r, Snapshot memory s, BorrowContext memory c)
        private view returns (uint256 low)
    {
        uint256 high = c.high;
        while (low < high) {
            uint256 mid = low + (high - low) / 2 + 1;
            uint256 added = _up(mid, RAY, s.borrowIndex);
            bool fits = _debtValue(c.oldShares + added, s.borrowIndex, c.price, c.unit) <= c.budget;
            if (r.borrowCap != 0 && _up(r.scaledDebt + added, s.borrowIndex, RAY) > r.borrowCap) fits = false;
            if (fits) low = mid;
            else high = mid - 1;
        }
    }

    /// @notice Includes share-burn rounding and LTV constraints; only debt-free exits bypass pause.
    function maxWithdrawable(address asset, address user) external view returns (uint256) {
        Snapshot memory s = _preview(asset);
        WithdrawalContext memory w;
        w.shares = scaledSupplyOf[asset][user];
        w.balance = Math.mulDiv(w.shares, s.supplyIndex, RAY);
        uint256 high = Math.min(w.balance, s.cash);
        if (!_hasDebt(user)) return high;
        if (paused() || _isStale()) return 0;
        Account memory a = _previewAccount(user);
        if (a.debt > a.capacity) return 0;
        w.supplyIndex = s.supplyIndex;
        w.ltv = _reserves[asset].ltv;
        w.price = _price(asset);
        uint256 otherCapacity = a.capacity
            - _collateralCapacity(w.shares, w.supplyIndex, w.price, w.ltv, _unit(asset));
        if (otherCapacity >= a.debt) return high;
        w.requiredCapacity = a.debt - otherCapacity;
        return _withdrawalLimit(asset, w, high);
    }

    function _withdrawalLimit(address asset, WithdrawalContext memory w, uint256 high)
        private view returns (uint256)
    {
        uint256 low;
        while (low < high) {
            uint256 mid = low + (high - low) / 2 + 1;
            uint256 burned = mid == w.balance ? w.shares : _up(mid, RAY, w.supplyIndex);
            if (_collateralCapacity(w.shares - burned, w.supplyIndex, w.price, w.ltv, _unit(asset))
                >= w.requiredCapacity) low = mid;
            else high = mid - 1;
        }
        return low;
    }

    function _preview(address asset) private view returns (Snapshot memory s) {
        _requireAsset(asset);
        Reserve storage r = _reserves[asset];
        s.supplyIndex = r.supplyIndex;
        s.borrowIndex = r.borrowIndex;
        uint256 oldDebt = _up(r.scaledDebt, s.borrowIndex, RAY);
        s.cash = IERC20(asset).balanceOf(address(this));
        uint256 elapsed = block.timestamp - r.lastUpdate;
        if (elapsed != 0 && r.scaledDebt != 0) {
            uint256 utilization = _utilization(oldDebt, s.cash);
            uint256 rate = _rate(utilization);
            s.borrowIndex += Math.mulDiv(s.borrowIndex, rate * elapsed, WAD * YEAR);
            if (r.scaledSupply != 0) {
                uint256 interest = _up(r.scaledDebt, s.borrowIndex, RAY) - oldDebt;
                uint256 supplierBudget = Math.mulDiv(interest, BPS - RESERVE_FACTOR, BPS);
                uint256 rateDelta = Math.mulDiv(s.supplyIndex, _supplyRate(rate, utilization) * elapsed, WAD * YEAR);
                // Supplier rounding must never consume previously accrued reserves.
                s.supplyIndex += Math.min(rateDelta, Math.mulDiv(supplierBudget, RAY, r.scaledSupply));
            }
        }
        s.totalBorrowed = _up(r.scaledDebt, s.borrowIndex, RAY);
        s.totalSupplied = Math.mulDiv(r.scaledSupply, s.supplyIndex, RAY);
        if (s.cash + s.totalBorrowed < s.totalSupplied) revert AccountingDeficit(asset);
        s.protocolReserves = s.cash + s.totalBorrowed - s.totalSupplied;
    }

    function _accrue(address asset) private {
        Snapshot memory s = _preview(asset);
        Reserve storage r = _reserves[asset];
        r.supplyIndex = s.supplyIndex;
        r.borrowIndex = s.borrowIndex;
        r.protocolReserves = s.protocolReserves;
        r.lastUpdate = block.timestamp;
        emit Accrued(asset, s.supplyIndex, s.borrowIndex, s.protocolReserves, block.timestamp);
    }

    function _accrueAll() private {
        for (uint256 i; i < 3; ++i) {
            _accrue(_assetAt(i));
        }
    }

    function _syncReserves(address asset) private {
        _reserves[asset].protocolReserves = _preview(asset).protocolReserves;
        emit ReservesSynced(asset, _reserves[asset].protocolReserves);
    }

    function _repay(address asset, address borrower, uint256 limit) private returns (uint256 applied) {
        if (limit == 0) revert ZeroAmount();
        Reserve storage r = _reserves[asset];
        uint256 debtShares = scaledDebtOf[asset][borrower];
        uint256 burned;
        (burned, applied) = _repayQuote(debtShares, r.borrowIndex, limit);
        scaledDebtOf[asset][borrower] = debtShares - burned;
        r.scaledDebt -= burned;
        _receive(asset, msg.sender, applied);
        _syncReserves(asset);
        emit Repay(borrower, msg.sender, asset, applied, burned);
    }

    function _repayQuote(uint256 shares, uint256 index, uint256 limit)
        private pure returns (uint256 burned, uint256 applied)
    {
        uint256 debt = _up(shares, index, RAY);
        if (limit >= debt) burned = shares;
        else burned = Math.mulDiv(limit, RAY, index);
        if (burned == 0) revert ZeroShares();
        applied = _up(burned, index, RAY);
    }

    function _previewAccount(address user) private view returns (Account memory) {
        return _account(user, true);
    }

    function _currentAccount(address user) private view returns (Account memory) {
        return _account(user, false);
    }

    function _account(address user, bool preview) private view returns (Account memory a) {
        for (uint256 i; i < 3; ++i) {
            address asset = _assetAt(i);
            Reserve storage r = _reserves[asset];
            uint256 supplyIndex = r.supplyIndex;
            uint256 borrowIndex = r.borrowIndex;
            if (preview) {
                Snapshot memory s = _preview(asset);
                supplyIndex = s.supplyIndex;
                borrowIndex = s.borrowIndex;
            }
            uint256 price = _price(asset);
            uint256 unit = _unit(asset);
            uint256 supply = Math.mulDiv(scaledSupplyOf[asset][user], supplyIndex, RAY);
            uint256 value = Math.mulDiv(supply, price, unit);
            a.collateral += value;
            a.capacity += Math.mulDiv(value, r.ltv, BPS);
            a.liquidationValue += Math.mulDiv(value, r.liquidationThreshold, BPS);
            a.debt += _debtValue(scaledDebtOf[asset][user], borrowIndex, price, unit);
        }
    }

    function _debtValue(uint256 shares, uint256 index, uint256 price, uint256 unit)
        private pure returns (uint256)
    {
        return _up(_up(shares, index, RAY), price, unit);
    }

    function _collateralCapacity(uint256 shares, uint256 index, uint256 price, uint256 ltv, uint256 unit)
        private pure returns (uint256)
    {
        return Math.mulDiv(Math.mulDiv(Math.mulDiv(shares, index, RAY), price, unit), ltv, BPS);
    }

    function _utilization(uint256 debt, uint256 cash) private pure returns (uint256) {
        if (debt == 0) return 0;
        return Math.mulDiv(debt, WAD, cash + debt);
    }

    function _rate(uint256 utilization) private pure returns (uint256) {
        if (utilization <= OPTIMAL_UTILIZATION) {
            return BASE_RATE + Math.mulDiv(SLOPE1, utilization, OPTIMAL_UTILIZATION);
        }
        return BASE_RATE + SLOPE1 + Math.mulDiv(SLOPE2, utilization - OPTIMAL_UTILIZATION, WAD - OPTIMAL_UTILIZATION);
    }

    function _supplyRate(uint256 rate, uint256 utilization) private pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(rate, utilization, WAD), BPS - RESERVE_FACTOR, BPS);
    }

    function _receive(address asset, address from, uint256 amount) private returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(from, address(this), amount);
        uint256 afterBalance = IERC20(asset).balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert UnsupportedTokenBehavior();
        received = afterBalance - beforeBalance;
        if (received == 0) revert ZeroAmount();
    }

    function _send(address asset, address to, uint256 amount) private {
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransfer(to, amount);
        uint256 afterBalance = IERC20(asset).balanceOf(address(this));
        if (afterBalance > beforeBalance || beforeBalance - afterBalance != amount) revert UnsupportedTokenBehavior();
    }

    function _requireLiquidity(address asset, uint256 amount) private view {
        uint256 cash = IERC20(asset).balanceOf(address(this));
        if (amount > cash) revert InsufficientLiquidity(asset, amount, cash);
    }

    function _requireAsset(address asset) private view {
        if (asset != USDC && asset != EURC && asset != CIRBTC) revert UnsupportedAsset(asset);
    }

    function _assetAt(uint256 i) private view returns (address) {
        return i == 0 ? USDC : (i == 1 ? EURC : CIRBTC);
    }

    function _unit(address asset) private view returns (uint256) {
        return asset == USDC ? usdcUnit : (asset == EURC ? eurcUnit : cirBtcUnit);
    }

    function _hasDebt(address user) private view returns (bool) {
        return scaledDebtOf[USDC][user] != 0 || scaledDebtOf[EURC][user] != 0
            || scaledDebtOf[CIRBTC][user] != 0;
    }

    function _price(address asset) private view returns (uint256) {
        return asset == USDC ? usdcUsdPrice() : (asset == EURC ? eurUsdPrice() : btcUsdPrice());
    }

    /// @dev Failed/invalid reads are reported rather than reverted so freshness views fail closed.
    /// Returns the feed's timestamp even for an invalid round, or zero when unreadable.
    function _readFeed(AggregatorV3Interface feed, uint8 decimals_)
        private view returns (bool valid, uint256 price8, uint256 updatedAt)
    {
        try feed.latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 timestamp, uint80 answeredInRound
        ) {
            updatedAt = timestamp;
            if (answer <= 0 || timestamp == 0 || answeredInRound < roundId || timestamp > block.timestamp) {
                return (false, 0, updatedAt);
            }
            uint256 unsignedAnswer = uint256(answer);
            if (decimals_ > 8) {
                price8 = unsignedAnswer / (10 ** uint256(decimals_ - 8));
            } else {
                uint256 factor = 10 ** uint256(8 - decimals_);
                if (unsignedAnswer > type(uint256).max / factor) return (false, 0, updatedAt);
                price8 = unsignedAnswer * factor;
            }
            // An answer that rounds to zero cannot be used as a denominator in risk math.
            valid = price8 != 0;
            return (valid, price8, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    function _priceFreshness() private view returns (bool fresh, uint256 oldestUpdatedAt) {
        (bool usdcValid,, uint256 usdcUpdatedAt) = _readFeed(usdcUsdFeed, usdcFeedDecimals);
        (bool eurcValid,, uint256 eurcUpdatedAt) = _readFeed(eurcUsdFeed, feedDecimals);
        (bool btcValid,, uint256 btcUpdatedAt) = _readFeed(btcUsdFeed, btcFeedDecimals);
        oldestUpdatedAt = Math.min(Math.min(usdcUpdatedAt, eurcUpdatedAt), btcUpdatedAt);
        fresh = usdcValid && eurcValid && btcValid && block.timestamp - oldestUpdatedAt <= maxPriceAge;
    }

    function _isStale() private view returns (bool) {
        (bool fresh,) = _priceFreshness();
        return !fresh;
    }

    function _requireFreshPrice() private view {
        (bool fresh, uint256 oldestUpdatedAt) = _priceFreshness();
        if (!fresh) revert StalePrice(oldestUpdatedAt, maxPriceAge);
    }

    function _up(uint256 x, uint256 y, uint256 denominator) private pure returns (uint256) {
        return Math.mulDiv(x, y, denominator, Math.Rounding.Ceil);
    }
}
