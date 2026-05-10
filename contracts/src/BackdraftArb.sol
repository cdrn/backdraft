// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title BackdraftArb
/// @notice Atomic cross-DEX arbitrage on Base
/// @dev Buys on one pool, sells on another in a single tx. Reverts if not profitable.

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IUniswapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract BackdraftArb {
    address public immutable owner;
    address public immutable weth;

    // V3 sqrt price limits
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Tracks the pool we're currently swapping with — used to validate V3 callbacks.
    // Prevents spoofed callbacks where an attacker passes their own address as cb.pool.
    address private _activeV3Pool;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _weth) {
        owner = msg.sender;
        weth = _weth;
    }

    receive() external payable {}

    /// @notice Execute a V2→V2 arbitrage
    function arbV2V2(
        address buyPool,
        address sellPool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minProfit
    ) external onlyOwner {
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));

        uint256 buyOutput = _getV2AmountOut(buyPool, tokenIn, tokenOut, amountIn);
        IERC20(tokenIn).transfer(buyPool, amountIn);
        _v2Swap(buyPool, tokenOut, buyOutput);

        uint256 sellOutput = _getV2AmountOut(sellPool, tokenOut, tokenIn, buyOutput);
        IERC20(tokenOut).transfer(sellPool, buyOutput);
        _v2Swap(sellPool, tokenIn, sellOutput);

        uint256 balanceAfter = IERC20(tokenIn).balanceOf(address(this));
        require(balanceAfter >= balanceBefore + minProfit, "not profitable");
    }

    /// @notice Execute a V2→V3 arbitrage
    function arbV2V3(
        address buyPool,
        address sellPool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minProfit
    ) external onlyOwner {
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));

        uint256 buyOutput = _getV2AmountOut(buyPool, tokenIn, tokenOut, amountIn);
        IERC20(tokenIn).transfer(buyPool, amountIn);
        _v2Swap(buyPool, tokenOut, buyOutput);

        _v3Swap(sellPool, tokenOut, tokenIn, buyOutput);

        uint256 balanceAfter = IERC20(tokenIn).balanceOf(address(this));
        require(balanceAfter >= balanceBefore + minProfit, "not profitable");
    }

    /// @notice Execute a V3→V2 arbitrage
    function arbV3V2(
        address buyPool,
        address sellPool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minProfit
    ) external onlyOwner {
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));

        _v3Swap(buyPool, tokenIn, tokenOut, amountIn);

        uint256 tokenOutBalance = IERC20(tokenOut).balanceOf(address(this));
        uint256 sellOutput = _getV2AmountOut(sellPool, tokenOut, tokenIn, tokenOutBalance);
        IERC20(tokenOut).transfer(sellPool, tokenOutBalance);
        _v2Swap(sellPool, tokenIn, sellOutput);

        uint256 balanceAfter = IERC20(tokenIn).balanceOf(address(this));
        require(balanceAfter >= balanceBefore + minProfit, "not profitable");
    }

    /// @notice Execute a V3→V3 arbitrage
    function arbV3V3(
        address buyPool,
        address sellPool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minProfit
    ) external onlyOwner {
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));

        _v3Swap(buyPool, tokenIn, tokenOut, amountIn);

        uint256 tokenOutBalance = IERC20(tokenOut).balanceOf(address(this));
        _v3Swap(sellPool, tokenOut, tokenIn, tokenOutBalance);

        uint256 balanceAfter = IERC20(tokenIn).balanceOf(address(this));
        require(balanceAfter >= balanceBefore + minProfit, "not profitable");
    }

    // --- V3 Callback ---

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // Validate caller is the pool we initiated the swap on — not attacker-controlled data
        require(msg.sender == _activeV3Pool, "invalid callback");

        V3CallbackData memory cb = abi.decode(data, (V3CallbackData));
        uint256 amountOwed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(cb.tokenIn).transfer(msg.sender, amountOwed);
    }

    // --- Internal helpers ---

    struct V3CallbackData {
        address tokenIn;
    }

    function _v2Swap(
        address pool,
        address tokenOut,
        uint256 amountOut
    ) internal {
        address token0 = IUniswapV2Pair(pool).token0();
        (uint256 amount0Out, uint256 amount1Out) = tokenOut == token0
            ? (amountOut, uint256(0))
            : (uint256(0), amountOut);
        IUniswapV2Pair(pool).swap(amount0Out, amount1Out, address(this), "");
    }

    function _getV2AmountOut(
        address pool,
        address tokenIn,
        address, // tokenOut — unused but kept for readability at call sites
        uint256 amountIn
    ) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pool).getReserves();
        address token0 = IUniswapV2Pair(pool).token0();
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));

        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    function _v3Swap(
        address pool,
        address tokenIn,
        address, // tokenOut
        uint256 amountIn
    ) internal {
        address token0 = IUniswapV3Pool(pool).token0();
        bool zeroForOne = tokenIn == token0;

        // Set active pool before swap so callback can validate
        _activeV3Pool = pool;

        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(V3CallbackData({tokenIn: tokenIn}))
        );

        // Clear after swap
        _activeV3Pool = address(0);
    }

    // --- Admin ---

    function withdraw(address token) external onlyOwner {
        if (token == address(0)) {
            payable(owner).transfer(address(this).balance);
        } else {
            IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
        }
    }

    function wrapETH() external onlyOwner {
        IWETH(weth).deposit{value: address(this).balance}();
    }

    function unwrapETH(uint256 amount) external onlyOwner {
        IWETH(weth).withdraw(amount);
    }
}
