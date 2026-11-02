use super::{PaneLeaf, PaneNode, PaneSplit};

pub fn get_leaves(node: &PaneNode) -> Vec<&PaneLeaf> {
    match node {
        PaneNode::Leaf(leaf) => vec![leaf],
        PaneNode::Split(split) => {
            let mut leaves = get_leaves(&split.children.0);
            leaves.extend(get_leaves(&split.children.1));
            leaves
        }
    }
}

pub fn find_leaf<'a>(node: &'a PaneNode, pane_id: &str) -> Option<&'a PaneLeaf> {
    match node {
        PaneNode::Leaf(leaf) => (leaf.id == pane_id).then_some(leaf),
        PaneNode::Split(split) => {
            find_leaf(&split.children.0, pane_id).or_else(|| find_leaf(&split.children.1, pane_id))
        }
    }
}

pub fn find_leaf_by_tab_id<'a>(node: &'a PaneNode, tab_id: &str) -> Option<&'a PaneLeaf> {
    match node {
        PaneNode::Leaf(leaf) => leaf.tabs.iter().any(|tab| tab.id == tab_id).then_some(leaf),
        PaneNode::Split(split) => find_leaf_by_tab_id(&split.children.0, tab_id)
            .or_else(|| find_leaf_by_tab_id(&split.children.1, tab_id)),
    }
}

pub fn has_any_tabs(node: &PaneNode) -> bool {
    match node {
        PaneNode::Leaf(leaf) => !leaf.tabs.is_empty(),
        PaneNode::Split(split) => {
            has_any_tabs(&split.children.0) || has_any_tabs(&split.children.1)
        }
    }
}

pub fn map_leaves(node: &mut PaneNode, f: &mut impl FnMut(&mut PaneLeaf)) {
    match node {
        PaneNode::Leaf(leaf) => f(leaf),
        PaneNode::Split(split) => {
            map_leaves(&mut split.children.0, f);
            map_leaves(&mut split.children.1, f);
        }
    }
}

pub fn replace_node(root: &mut PaneNode, node_id: &str, replacement: &PaneNode) -> bool {
    if root.id() == node_id {
        *root = replacement.clone();
        return true;
    }
    match root {
        PaneNode::Leaf(_) => false,
        PaneNode::Split(split) => {
            let left = replace_node(&mut split.children.0, node_id, replacement);
            let right = replace_node(&mut split.children.1, node_id, replacement);
            left || right
        }
    }
}

enum Removal {
    Kept(PaneNode),
    Removed(Option<PaneNode>),
}

fn is_leaf_with_id(node: &PaneNode, leaf_id: &str) -> bool {
    matches!(node, PaneNode::Leaf(leaf) if leaf.id == leaf_id)
}

fn remove(node: PaneNode, leaf_id: &str) -> Removal {
    let mut split = match node {
        PaneNode::Leaf(leaf) if leaf.id == leaf_id => return Removal::Removed(None),
        PaneNode::Leaf(_) => return Removal::Kept(node),
        PaneNode::Split(split) => split,
    };
    let (left, right) = *split.children;
    if is_leaf_with_id(&left, leaf_id) {
        return Removal::Removed(Some(right));
    }
    if is_leaf_with_id(&right, leaf_id) {
        return Removal::Removed(Some(left));
    }
    let left = match remove(left, leaf_id) {
        Removal::Removed(None) => return Removal::Removed(Some(right)),
        Removal::Removed(Some(left)) => {
            split.children = Box::new((left, right));
            return Removal::Removed(Some(PaneNode::Split(split)));
        }
        Removal::Kept(left) => left,
    };
    match remove(right, leaf_id) {
        Removal::Removed(None) => Removal::Removed(Some(left)),
        Removal::Removed(Some(right)) => {
            split.children = Box::new((left, right));
            Removal::Removed(Some(PaneNode::Split(split)))
        }
        Removal::Kept(right) => {
            split.children = Box::new((left, right));
            Removal::Kept(PaneNode::Split(split))
        }
    }
}

pub fn remove_leaf(root: PaneNode, leaf_id: &str) -> Option<PaneNode> {
    match remove(root, leaf_id) {
        Removal::Kept(node) => Some(node),
        Removal::Removed(node) => node,
    }
}

pub fn find_split<'a>(node: &'a PaneNode, split_id: &str) -> Option<&'a PaneSplit> {
    match node {
        PaneNode::Leaf(_) => None,
        PaneNode::Split(split) if split.id == split_id => Some(split),
        PaneNode::Split(split) => find_split(&split.children.0, split_id)
            .or_else(|| find_split(&split.children.1, split_id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree(value: serde_json::Value) -> PaneNode {
        serde_json::from_value(value).unwrap()
    }

    fn leaf(id: &str, tab_ids: &[&str]) -> serde_json::Value {
        json!({
            "type": "leaf",
            "id": id,
            "tabs": tab_ids.iter().map(|t| json!({ "id": t, "type": "shell", "label": t })).collect::<Vec<_>>(),
            "activeTabId": tab_ids.first().copied().unwrap_or("")
        })
    }

    fn split(id: &str, left: serde_json::Value, right: serde_json::Value) -> serde_json::Value {
        json!({ "type": "split", "id": id, "direction": "horizontal", "ratio": 0.5, "children": [left, right] })
    }

    fn nested() -> PaneNode {
        tree(split(
            "s1",
            leaf("a", &["t1"]),
            split("s2", leaf("b", &["t2"]), leaf("c", &["t3"])),
        ))
    }

    fn ids(leaves: Vec<&PaneLeaf>) -> Vec<&str> {
        leaves.into_iter().map(|l| l.id.as_str()).collect()
    }

    #[test]
    fn get_leaves_returns_leaves_left_to_right() {
        assert_eq!(ids(get_leaves(&nested())), ["a", "b", "c"]);
    }

    #[test]
    fn find_leaf_finds_a_nested_pane_and_misses_split_ids() {
        let root = nested();
        assert_eq!(find_leaf(&root, "c").map(|l| l.id.as_str()), Some("c"));
        assert!(find_leaf(&root, "s2").is_none());
        assert!(find_leaf(&root, "missing").is_none());
    }

    #[test]
    fn find_leaf_by_tab_id_finds_the_leaf_holding_the_tab() {
        let root = nested();
        assert_eq!(
            find_leaf_by_tab_id(&root, "t2").map(|l| l.id.as_str()),
            Some("b")
        );
        assert!(find_leaf_by_tab_id(&root, "nope").is_none());
    }

    #[test]
    fn has_any_tabs_looks_through_nested_splits() {
        assert!(!has_any_tabs(&tree(split(
            "s",
            leaf("a", &[]),
            split("s2", leaf("b", &[]), leaf("c", &[]))
        ))));
        assert!(has_any_tabs(&tree(split(
            "s",
            leaf("a", &[]),
            split("s2", leaf("b", &[]), leaf("c", &["t"]))
        ))));
    }

    #[test]
    fn map_leaves_visits_every_leaf_in_order() {
        let mut root = nested();
        let mut seen = Vec::new();
        map_leaves(&mut root, &mut |leaf| {
            seen.push(leaf.id.clone());
            leaf.active_tab_id = format!("{}!", leaf.id);
        });
        assert_eq!(seen, ["a", "b", "c"]);
        assert!(
            get_leaves(&root)
                .iter()
                .all(|l| l.active_tab_id == format!("{}!", l.id))
        );
    }

    #[test]
    fn replace_node_swaps_the_matching_subtree_and_reports_a_miss() {
        let mut root = nested();
        assert!(replace_node(&mut root, "s2", &tree(leaf("z", &["tz"]))));
        assert_eq!(ids(get_leaves(&root)), ["a", "z"]);
        assert!(!replace_node(&mut root, "missing", &tree(leaf("y", &[]))));
        assert_eq!(ids(get_leaves(&root)), ["a", "z"]);
    }

    #[test]
    fn replace_node_replaces_the_root() {
        let mut root = nested();
        assert!(replace_node(&mut root, "s1", &tree(leaf("only", &[]))));
        assert_eq!(root, tree(leaf("only", &[])));
    }

    #[test]
    fn remove_leaf_collapses_the_parent_split_to_the_sibling() {
        let root = tree(split("s1", leaf("a", &["t1"]), leaf("b", &["t2"])));
        assert_eq!(
            remove_leaf(root.clone(), "a"),
            Some(tree(leaf("b", &["t2"])))
        );
        assert_eq!(remove_leaf(root, "b"), Some(tree(leaf("a", &["t1"]))));
    }

    #[test]
    fn remove_leaf_returns_none_for_the_only_leaf() {
        assert_eq!(remove_leaf(tree(leaf("a", &["t1"])), "a"), None);
    }

    #[test]
    fn remove_leaf_collapses_deep_splits_and_keeps_the_rest() {
        let root = tree(split(
            "s1",
            split(
                "s2",
                leaf("a", &[]),
                split("s3", leaf("b", &[]), leaf("c", &[])),
            ),
            leaf("d", &[]),
        ));
        let expected = tree(split(
            "s1",
            split("s2", leaf("a", &[]), leaf("c", &[])),
            leaf("d", &[]),
        ));
        assert_eq!(remove_leaf(root, "b"), Some(expected));
    }

    #[test]
    fn remove_leaf_removes_from_the_right_subtree_when_the_left_has_no_match() {
        let root = tree(split(
            "s1",
            split("s2", leaf("a", &[]), leaf("b", &[])),
            split("s3", leaf("c", &[]), leaf("d", &[])),
        ));
        let expected = tree(split(
            "s1",
            split("s2", leaf("a", &[]), leaf("b", &[])),
            leaf("c", &[]),
        ));
        assert_eq!(remove_leaf(root, "d"), Some(expected));
    }

    #[test]
    fn remove_leaf_removes_only_the_first_match_left_first() {
        let root = tree(split(
            "s1",
            split("s2", leaf("x", &[]), leaf("a", &[])),
            split("s3", leaf("b", &[]), leaf("x", &[])),
        ));
        let expected = tree(split(
            "s1",
            leaf("a", &[]),
            split("s3", leaf("b", &[]), leaf("x", &[])),
        ));
        assert_eq!(remove_leaf(root, "x"), Some(expected));
    }

    #[test]
    fn remove_leaf_with_no_match_returns_the_tree_unchanged() {
        assert_eq!(remove_leaf(nested(), "missing"), Some(nested()));
    }

    #[test]
    fn find_split_finds_nested_splits_and_ignores_leaves() {
        let root = nested();
        assert_eq!(find_split(&root, "s2").map(|s| s.id.as_str()), Some("s2"));
        assert_eq!(find_split(&root, "s1").map(|s| s.id.as_str()), Some("s1"));
        assert!(find_split(&root, "a").is_none());
    }
}
