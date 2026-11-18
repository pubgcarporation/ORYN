// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IOrynPoolHooks {
    function previewIndexes(address asset) external view returns (uint256 supplyIndex, uint256 borrowIndex);
    function finalizeTransfer(address asset, address from, address to, uint256 scaledAmount) external;
}

/**
 * @title OrynToken
 * @notice Indexed supply receipts or non-transferable debt receipts for one Oryn reserve.
 * @dev Independently implemented scaled-balance accounting: live balances multiply shares by
 * the pool's previewed 1e18 index. Supply rounds down; debt rounds up. Interest therefore
 * appears without transactions or Transfer events. No underlying assets are held here.
 * Clones share one implementation to reduce deployment gas; metadata and ledgers use clone storage.
 */
contract OrynToken is IERC20Metadata, IERC20Errors {
    address public POOL;
    address public UNDERLYING;
    bool public IS_DEBT;
    uint8 private _decimals;
    bool private _initialized;
    string private _name;
    string private _symbol;
    mapping(address owner => mapping(address spender => uint256)) private _allowances;

    mapping(address user => uint256) private scaled;
    uint256 private scaledTotal;

    error NotPool();
    error NotTransferable();
    error ZeroShares();
    error AlreadyInitialized();

    /// @dev Lock the implementation; newly created clones start with uninitialized storage.
    constructor() {
        _initialized = true;
    }

    function initialize(address pool, address underlying, bool isDebt, string memory name_,
        string memory symbol_, uint8 decimals_) external
    {
        if (_initialized) revert AlreadyInitialized();
        if (pool == address(0) || underlying == address(0)) revert ERC20InvalidReceiver(address(0));
        _initialized = true;
        POOL = pool;
        UNDERLYING = underlying;
        IS_DEBT = isDebt;
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    modifier onlyPool() {
        if (msg.sender != POOL) revert NotPool();
        _;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function scaledBalanceOf(address user) external view returns (uint256) {
        return scaled[user];
    }

    function scaledTotalSupply() external view returns (uint256) {
        return scaledTotal;
    }

    function balanceOf(address user) public view override returns (uint256) {
        return _underlyingAmount(scaled[user], _index());
    }

    function totalSupply() public view override returns (uint256) {
        return _underlyingAmount(scaledTotal, _index());
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        return IS_DEBT ? 0 : _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        if (IS_DEBT) revert NotTransferable();
        _approve(msg.sender, spender, amount, true);
        return true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (IS_DEBT) revert NotTransferable();
        _transferUnderlying(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (IS_DEBT) revert NotTransferable();
        _spendAllowance(from, msg.sender, amount);
        _transferUnderlying(from, to, amount);
        return true;
    }

    /// @dev Preserve ERC-20 approval errors and suppress Approval when spending an allowance.
    function _approve(address owner, address spender, uint256 amount, bool emitEvent) private {
        if (owner == address(0)) revert ERC20InvalidApprover(address(0));
        if (spender == address(0)) revert ERC20InvalidSpender(address(0));
        _allowances[owner][spender] = amount;
        if (emitEvent) emit Approval(owner, spender, amount);
    }

    function _spendAllowance(address owner, address spender, uint256 amount) private {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance < type(uint256).max) {
            if (currentAllowance < amount) revert ERC20InsufficientAllowance(spender, currentAllowance, amount);
            unchecked {
                _approve(owner, spender, currentAllowance - amount, false);
            }
        }
    }

    /// @notice Pool-only issuance in scaled units; Transfer reports indexed underlying units.
    function mintScaled(address to, uint256 scaledAmount) external onlyPool {
        if (to == address(this)) revert ERC20InvalidReceiver(to);
        _mint(to, scaledAmount);
    }

    /// @notice Pool-only destruction in scaled units; Transfer reports indexed underlying units.
    function burnScaled(address from, uint256 scaledAmount) external onlyPool {
        _burn(from, scaledAmount);
    }

    /// @notice Pool-only share movement for liquidation, deliberately bypassing the health hook.
    function transferScaled(address from, address to, uint256 scaledAmount) external onlyPool {
        if (to == address(this)) revert ERC20InvalidReceiver(to);
        _transfer(from, to, scaledAmount);
    }

    function _mint(address to, uint256 shares) internal {
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        _update(address(0), to, shares);
    }

    function _burn(address from, uint256 shares) internal {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        _update(from, address(0), shares);
    }

    function _transfer(address from, address to, uint256 shares) internal {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        _update(from, to, shares);
    }

    function _transferUnderlying(address from, address to, uint256 amount) private {
        if (from == address(0)) revert ERC20InvalidSender(from);
        if (to == address(0) || to == address(this)) revert ERC20InvalidReceiver(to);
        uint256 index = _index();
        uint256 shares = Math.mulDiv(amount, 1e18, index, Math.Rounding.Ceil);
        if (shares == 0) revert ZeroShares();
        if (amount == _underlyingAmount(scaled[from], index)) shares = scaled[from];
        _moveScaled(from, to, shares);
        IOrynPoolHooks(POOL).finalizeTransfer(UNDERLYING, from, to, shares);
        emit Transfer(from, to, amount);
    }

    /// @dev Only pool entry points use the internal mint/burn/transfer helpers, in scaled units.
    function _update(address from, address to, uint256 shares) internal {
        uint256 amount = _underlyingAmount(shares, _index());
        if (from == address(0)) {
            scaledTotal += shares;
            scaled[to] += shares;
        } else if (to == address(0)) {
            _debitScaled(from, shares);
            scaledTotal -= shares;
        } else {
            _moveScaled(from, to, shares);
        }
        emit Transfer(from, to, amount);
    }

    function _moveScaled(address from, address to, uint256 shares) private {
        _debitScaled(from, shares);
        scaled[to] += shares;
    }

    function _debitScaled(address from, uint256 shares) private {
        uint256 available = scaled[from];
        if (available < shares) revert ERC20InsufficientBalance(from, available, shares);
        scaled[from] = available - shares;
    }

    function _index() private view returns (uint256) {
        (uint256 supplyIndex, uint256 borrowIndex) = IOrynPoolHooks(POOL).previewIndexes(UNDERLYING);
        return IS_DEBT ? borrowIndex : supplyIndex;
    }

    function _underlyingAmount(uint256 shares, uint256 index) private view returns (uint256) {
        return Math.mulDiv(shares, index, 1e18, IS_DEBT ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }
}
