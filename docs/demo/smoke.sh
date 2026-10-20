source "$(dirname "$0")/demo-env.sh"
detent run new --ticket DEMO-42 --slug banner --no-worktree | pj
detent next | pj
detent stage begin plan | pj
detent stage begin intake | pj >/dev/null; detent stage end intake | pj
brief DEMO-42; detent stage end intake | pj
detent pack validate --pack packs/example/stack.yaml | packs
