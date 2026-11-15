// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/**
 * @title OrynPool
 * @notice Two-reserve, cross-collateral money market intended for Arc Testnet (5042002).
 * @dev Both immutable assets MUST have 6 decimals; decimals() is deliberately never called.
 * Expected testnet assets: USDC 0x3600000000000000000000000000000000000000 and
 * EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a. Addresses are constructor inputs.
 * USDC/USD and EURC/USD are read from their immutable Chainlink-compatible AggregatorV3 feeds.
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
 * amount. The configured USDC and EURC must be standard six-decimal ERC-20 tokens.
 */
contract OrynPool is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Fixed-origin indexes use 18 decimals; retained RAY name preserves the existing API.
    uint256 public constant RAY = 1e18;
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant ASSET_UNIT = 1e6;
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
    AggregatorV3Interface public immutable usdcUsdFeed;
    AggregatorV3Interface public immutable eurcUsdFeed;
    uint8 public immutable usdcFeedDecimals;
    uint8 public immutable feedDecimals;
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

    /// @notice Amounts use 6 decimals, USD values 8, APR and health factors 18.
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

    /// @dev Arrays always use index 0 = USDC, 1 = EURC. Totals are USD, not mixed currencies.
    struct UserPosition {
        uint256[2] supplyBalances;
        uint256[2] debtBalances;
        uint256 totalSupplyValueUsd;
        uint256 totalDebtValueUsd;
    }

    struct AccountData {
        uint256 collateralValueUsd;
        uint256 borrowValueUsd;
        uint256 borrowLimitUsd;
        uint256 liquidationLimitUsd;
        uint256 healthFactorWad;
        uint256[2] maxBorrow;
    }

    struct LiquidationQuote {
        uint256 collateralShares;
        uint256 collateral;
        uint256 maximumRepay;
    }

    mapping(address asset => Reserve) private _reserves;
    mapping(address asset => PendingRiskParams) private _pendingRiskParams;
    mapping(address asset => mapping(address user => uint256)) public scaledSupplyOf;
    mapping(address asset => mapping(address user => uint256)) public scaledDebtOf;

    error ZeroAddress();
    error IdenticalAssets();
    error UnsupportedAsset(address asset);
    error ZeroAmount();
    error ZeroShares();
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
    /// @param usdc Six-decimal USDC; market index zero.
    /// @param eurc Six-decimal EURC; market index one.
    /// @param usdcUsdFeed_ Chainlink-compatible USDC/USD feed.
    /// @param eurcUsdFeed_ Chainlink-compatible EURC/USD feed; use a mirror on Arc Testnet.
    /// @dev Reads only feed decimals at construction; initial rounds are not required.
    constructor(address initialOwner, address usdc, address eurc, address usdcUsdFeed_, address eurcUsdFeed_)
        Ownable(initialOwner)
    {
        if (usdc == address(0) || eurc == address(0) || initialOwner == address(0)
            || usdcUsdFeed_ == address(0) || eurcUsdFeed_ == address(0)) revert ZeroAddress();
        if (usdc == eurc) revert IdenticalAssets();
        USDC = usdc;
        EURC = eurc;
        usdcUsdFeed = AggregatorV3Interface(usdcUsdFeed_);
        eurcUsdFeed = AggregatorV3Interface(eurcUsdFeed_);
        uint8 usdcDecimals_ = AggregatorV3Interface(usdcUsdFeed_).decimals();
        uint8 decimals_ = AggregatorV3Interface(eurcUsdFeed_).decimals();
        if (usdcDecimals_ > 18 || decimals_ > 18) revert InvalidPrice();
        usdcFeedDecimals = usdcDecimals_;
        feedDecimals = decimals_;
        _initialize(usdc, 8_000, 8_500);
        _initialize(eurc, 7_500, 8_000);
    }

    function _initialize(address asset, uint256 ltv, uint256 threshold) private {
        _validateRiskParams(ltv, threshold, 500);
        Reserve storage r = _reserves[asset];
        r.supplyIndex = RAY;
        r.borrowIndex = RAY;
        r.lastUpdate = block.timestamp;
        r.ltv = ltv;
        r.liquidationThreshold = threshold;
        r.liquidationBonus = 500;
        emit ParamsUpdated(asset, ltv, threshold, 500, 0, 0);
    }

    /// @notice Deposits automatically collateralize both markets. Deposits stay open while paused so
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
        uint256 seized = _up(applied, _price(debtAsset), _price(collateralAsset));
        seized = _up(seized, BPS + _reserves[collateralAsset].liquidationBonus, BPS);
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
        // Invert both upward-rounded seizure steps, so even partial seizure fits.
        q.maximumRepay = Math.mulDiv(q.collateral, BPS, BPS + c.liquidationBonus);
        q.maximumRepay = Math.mulDiv(q.maximumRepay, _price(collateralAsset), _price(debtAsset));
        uint256 debt = _up(scaledDebtOf[debtAsset][borrower], _reserves[debtAsset].borrowIndex, RAY);
        q.maximumRepay = Math.min(q.maximumRepay, Math.mulDiv(debt, CLOSE_FACTOR, BPS));
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
    /// @dev Accrues both markets before updating the reserve and clears the applied proposal.
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

    /// @notice Initiates a two-step transfer, accruing both markets first.
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

    /// @notice Rescues only tokens unrelated to the two immutable markets.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (token == USDC || token == EURC || to == address(this)) revert InvalidRecipient();
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

    /// @notice Compatibility alias for eurUsdPrice(); indicative even if stale.
    function eurcUsdPrice() external view returns (uint256) {
        return eurUsdPrice();
    }

    /// @notice Returns the USDC source timestamp, or zero if its round cannot be read.
    function usdcPriceUpdatedAt() public view returns (uint256) {
        (,, uint256 updatedAt) = _readFeed(usdcUsdFeed, usdcFeedDecimals);
        return updatedAt;
    }

    /// @notice Returns the older source timestamp, or zero if either round cannot be read.
    function priceUpdatedAt() public view returns (uint256) {
        (,, uint256 usdcUpdatedAt) = _readFeed(usdcUsdFeed, usdcFeedDecimals);
        (,, uint256 eurcUpdatedAt) = _readFeed(eurcUsdFeed, feedDecimals);
        return Math.min(usdcUpdatedAt, eurcUpdatedAt);
    }

    function priceFeed() external view returns (address) {
        return address(eurcUsdFeed);
    }

    /// @notice Indicates whether both configured feed quotes are fresh for risk-increasing actions.
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

    /// @notice Balances include pending interest; arrays use USDC then EURC.
    /// @dev USD totals are indicative when the oracle is stale.
    function getUserPosition(address user) external view returns (UserPosition memory p) {
        if (user == address(0)) revert ZeroAddress();
        for (uint256 i; i < 2; ++i) {
            address token = i == 0 ? USDC : EURC;
            Snapshot memory s = _preview(token);
            p.supplyBalances[i] = Math.mulDiv(scaledSupplyOf[token][user], s.supplyIndex, RAY);
            p.debtBalances[i] = _up(scaledDebtOf[token][user], s.borrowIndex, RAY);
            p.totalSupplyValueUsd += Math.mulDiv(p.supplyBalances[i], _price(token), ASSET_UNIT);
            p.totalDebtValueUsd += _up(p.debtBalances[i], _price(token), ASSET_UNIT);
        }
    }

    /// @notice USD totals use eight decimals; maxBorrow uses six-decimal token units.
    /// @dev Health uses liquidation thresholds; borrow limits use collateral factors.
    function getAccountData(address user) external view returns (AccountData memory d) {
        if (user == address(0)) revert ZeroAddress();
        Account memory a = _previewAccount(user);
        d.collateralValueUsd = a.collateral;
        d.borrowValueUsd = a.debt;
        d.borrowLimitUsd = a.capacity;
        d.liquidationLimitUsd = a.liquidationValue;
        d.healthFactorWad = a.debt == 0 ? type(uint256).max : Math.mulDiv(a.liquidationValue, WAD, a.debt);
        d.maxBorrow[0] = maxBorrowable(USDC, user);
        d.maxBorrow[1] = maxBorrowable(EURC, user);
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
        uint256 debtAfter = a.debt - _debtValue(shares, s.borrowIndex, _price(token))
            + _debtValue(shares + _up(amount, RAY, s.borrowIndex), s.borrowIndex, _price(token));
        healthFactorAfterWad = debtAfter == 0 ? type(uint256).max : Math.mulDiv(a.liquidationValue, WAD, debtAfter);
        withinBorrowLimit = debtAfter <= a.capacity;
    }

    function assets() external view returns (address usdc, address eurc) {
        return (USDC, EURC);
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
        Snapshot memory u = _preview(USDC);
        Snapshot memory e = _preview(EURC);
        Account memory a = _account(user, u.supplyIndex, u.borrowIndex, e.supplyIndex, e.borrowIndex);
        return (a.collateral, a.debt, a.capacity, a.liquidationValue,
            a.debt == 0 ? type(uint256).max : Math.mulDiv(a.liquidationValue, WAD, a.debt));
    }

    /// @notice Exact rounding-aware upper limit; returns zero when paused or oracle stale.
    function maxBorrowable(address asset, address user) public view returns (uint256) {
        _requireAsset(asset);
        if (paused() || _isStale()) return 0;
        Snapshot memory s = _preview(asset);
        Account memory a = _previewAccount(user);
        if (a.debt >= a.capacity) return 0;
        uint256 oldShares = scaledDebtOf[asset][user];
        uint256 price = _price(asset);
        uint256 budget = a.capacity - (a.debt - _debtValue(oldShares, s.borrowIndex, price));
        uint256 high = s.cash;
        Reserve storage r = _reserves[asset];
        if (r.borrowCap != 0) {
            if (s.totalBorrowed >= r.borrowCap) return 0;
            high = Math.min(high, r.borrowCap - s.totalBorrowed);
        }
        high = Math.min(high, Math.mulDiv(budget, ASSET_UNIT, price));
        uint256 low;
        // Monotonic binary search accounts for debt-share and USD rounding and cap dust.
        while (low < high) {
            uint256 mid = low + (high - low) / 2 + 1;
            uint256 added = _up(mid, RAY, s.borrowIndex);
            bool fits = _debtValue(oldShares + added, s.borrowIndex, price) <= budget;
            if (r.borrowCap != 0 && _up(r.scaledDebt + added, s.borrowIndex, RAY) > r.borrowCap) fits = false;
            if (fits) low = mid;
            else high = mid - 1;
        }
        return low;
    }

    /// @notice Includes share-burn rounding and LTV constraints; only debt-free exits bypass pause.
    function maxWithdrawable(address asset, address user) external view returns (uint256) {
        Snapshot memory s = _preview(asset);
        uint256 shares = scaledSupplyOf[asset][user];
        uint256 balance = Math.mulDiv(shares, s.supplyIndex, RAY);
        uint256 high = Math.min(balance, s.cash);
        if (!_hasDebt(user)) return high;
        if (paused() || _isStale()) return 0;
        Account memory a = _previewAccount(user);
        if (a.debt > a.capacity) return 0;
        uint256 ltv = _reserves[asset].ltv;
        uint256 price = _price(asset);
        uint256 otherCapacity = a.capacity - _collateralCapacity(shares, s.supplyIndex, price, ltv);
        if (otherCapacity >= a.debt) return high;
        uint256 requiredCapacity = a.debt - otherCapacity;
        uint256 low;
        while (low < high) {
            uint256 mid = low + (high - low) / 2 + 1;
            uint256 burned = mid == balance ? shares : _up(mid, RAY, s.supplyIndex);
            if (_collateralCapacity(shares - burned, s.supplyIndex, price, ltv) >= requiredCapacity) low = mid;
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
        _accrue(USDC);
        _accrue(EURC);
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
        Snapshot memory u = _preview(USDC);
        Snapshot memory e = _preview(EURC);
        return _account(user, u.supplyIndex, u.borrowIndex, e.supplyIndex, e.borrowIndex);
    }

    function _currentAccount(address user) private view returns (Account memory) {
        return _account(user, _reserves[USDC].supplyIndex, _reserves[USDC].borrowIndex,
            _reserves[EURC].supplyIndex, _reserves[EURC].borrowIndex);
    }

    function _account(address user, uint256 us, uint256 ub, uint256 es, uint256 eb)
        private view returns (Account memory a)
    {
        for (uint256 i; i < 2; ++i) {
            address asset = i == 0 ? USDC : EURC;
            Reserve storage r = _reserves[asset];
            uint256 supply = Math.mulDiv(scaledSupplyOf[asset][user], i == 0 ? us : es, RAY);
            uint256 value = Math.mulDiv(supply, _price(asset), ASSET_UNIT);
            a.collateral += value;
            a.capacity += Math.mulDiv(value, r.ltv, BPS);
            a.liquidationValue += Math.mulDiv(value, r.liquidationThreshold, BPS);
            a.debt += _debtValue(scaledDebtOf[asset][user], i == 0 ? ub : eb, _price(asset));
        }
    }

    function _debtValue(uint256 shares, uint256 index, uint256 price) private pure returns (uint256) {
        return _up(_up(shares, index, RAY), price, ASSET_UNIT);
    }

    function _collateralCapacity(uint256 shares, uint256 index, uint256 price, uint256 ltv)
        private pure returns (uint256)
    {
        return Math.mulDiv(Math.mulDiv(Math.mulDiv(shares, index, RAY), price, ASSET_UNIT), ltv, BPS);
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
        if (asset != USDC && asset != EURC) revert UnsupportedAsset(asset);
    }

    function _hasDebt(address user) private view returns (bool) {
        return scaledDebtOf[USDC][user] != 0 || scaledDebtOf[EURC][user] != 0;
    }

    function _price(address asset) private view returns (uint256) {
        return asset == USDC ? usdcUsdPrice() : eurUsdPrice();
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
        oldestUpdatedAt = Math.min(usdcUpdatedAt, eurcUpdatedAt);
        fresh = usdcValid && eurcValid && block.timestamp - oldestUpdatedAt <= maxPriceAge;
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
