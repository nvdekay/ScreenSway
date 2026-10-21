//! Which key presses become shortcut chords, shared by the recorder and its tests.

/// Virtual-key codes of the modifier keys themselves (Shift, Ctrl, Alt, their left/right
/// variants and the Windows keys); they are never the main key of a chord.
pub fn is_modifier(key: u16) -> bool {
    matches!(key, 16..=18 | 91 | 92 | 160..=165)
}

/// The chord for a newly pressed `key`, or None when it is ordinary typing: only keys held
/// with Ctrl, Alt or Win count (Shift alone is capitals and symbols).
pub fn chord(key: u16, ctrl: bool, alt: bool, shift: bool, win: bool) -> Option<Vec<String>> {
    if is_modifier(key) || !(ctrl || alt || win) {
        return None;
    }
    let name = match key {
        8 => "Backspace".into(),
        9 => "Tab".into(),
        13 => "Enter".into(),
        27 => "Esc".into(),
        32 => "Space".into(),
        37 => "←".into(),
        38 => "↑".into(),
        39 => "→".into(),
        40 => "↓".into(),
        46 => "Delete".into(),
        48..=57 | 65..=90 => char::from_u32(u32::from(key))?.to_string(),
        112..=123 => format!("F{}", key - 111),
        // Mouse buttons and unnamed keys are not shown.
        _ => return None,
    };
    let mut keys = Vec::new();
    if ctrl { keys.push("Ctrl".to_string()); }
    if alt { keys.push("Alt".to_string()); }
    if shift { keys.push("Shift".to_string()); }
    if win { keys.push("Win".to_string()); }
    keys.push(name);
    Some(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_are_chords() {
        assert_eq!(chord(83, true, false, true, false), Some(vec!["Ctrl".into(), "Shift".into(), "S".into()]));
        assert_eq!(chord(115, false, true, false, false), Some(vec!["Alt".into(), "F4".into()]));
    }

    #[test]
    fn typing_and_modifiers_alone_are_not() {
        assert_eq!(chord(65, false, false, true, false), None, "Shift+A is a capital");
        assert_eq!(chord(65, false, false, false, false), None);
        assert_eq!(chord(162, true, false, false, false), None, "left Ctrl itself");
        assert_eq!(chord(18, true, false, false, false), None);
        assert_eq!(chord(1, true, false, false, false), None, "a mouse button");
    }
}
