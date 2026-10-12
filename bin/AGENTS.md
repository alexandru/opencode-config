# Python script guidelines

- Code must be statically typed and stay `mypy --strict` clean.
- Scripts declare pinned dependencies in PEP 723 inline metadata and run via `pipx run`.
- Expected failures raise a domain error with one clear message; users never see a traceback.
