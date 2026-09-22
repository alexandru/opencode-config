# Rust script guidelines

- Rust code must not panic. Do not use `unwrap`, `expect`, `panic!`, `todo!`, or `unreachable!`.
- Return `Result` and use `?` for fallible operations.
