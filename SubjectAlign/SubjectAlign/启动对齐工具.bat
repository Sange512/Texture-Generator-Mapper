@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 模型主体对齐工具...
python align_gui.py
if errorlevel 1 (
    echo.
    echo [启动失败] 请确认已安装 Python 及依赖:
    echo     pip install opencv-python numpy pillow
    echo     pip install "rembg[cpu]"
    echo     pip install tkinterdnd2   ^(可选, 启用拖拽^)
    pause
)
