"""Ruff target file: the default rule set (E4/E7/E9/F) flags undefined names."""


def greet() -> str:
    return greeting + "!"  # F821 — name `greeting` is not defined