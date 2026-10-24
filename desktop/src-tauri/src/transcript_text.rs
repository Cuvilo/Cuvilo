// Display/export only: raw provider text remains available to question merging.
pub fn display_text(text: &str) -> &str {
    text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || "，,；;、：:？?。！!…".contains(c))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leading_separators_preserve_meaningful_symbols() {
        for (input, expected) in [
            (" ？请介绍缓存？", "请介绍缓存？"),
            ("，如何处理穿透", "如何处理穿透"),
            (
                "。 我补充一个条件，如何处理？",
                "我补充一个条件，如何处理？",
            ),
            ("？ ，！… ", ""),
            ("\u{feff}\u{85}？缓存", "缓存"),
            (".NET 与 .5", ".NET 与 .5"),
            ("-5 和 −2", "-5 和 −2"),
            ("“如何实现？”", "“如何实现？”"),
            ("【转写缺口】", "【转写缺口】"),
        ] {
            assert_eq!(display_text(input), expected);
        }
    }
}
