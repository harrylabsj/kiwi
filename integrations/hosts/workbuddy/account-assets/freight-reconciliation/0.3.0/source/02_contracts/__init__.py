"""工具输入契约（JSON Schema）随包分发：安装后以 freight_contracts 资源读取。

设计正本仍是仓库根 02_contracts/ 下的 .json 文件；本 __init__ 只为让
setuptools 把该目录映射为可打包的 freight_contracts 包（见 pyproject.toml）。
"""
