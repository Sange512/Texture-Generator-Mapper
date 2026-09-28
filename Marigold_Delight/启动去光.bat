@echo off
chcp 65001 >nul
REM ============================================
REM  Marigold-IID 贴图去光 一键运行
REM  把要去光的图片拖到本 bat 上即可
REM ============================================
cd /d "%~dp0"

if "%~1"=="" (
    echo 用法：把图片文件或文件夹拖到本 bat 图标上
    echo 或者：启动去光.bat  你的图片路径
    echo.
    pause
    exit /b
)

python delight_marigold.py "%~1" --keep-size
echo.
echo ==== 处理结束 ====
pause
