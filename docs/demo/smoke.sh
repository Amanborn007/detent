source "$(dirname "$0")/demo-env.sh"
engine run new --ticket DEMO-42 --slug banner --no-worktree | pj
engine next | pj
engine stage begin plan | pj
engine stage begin intake | pj >/dev/null; engine stage end intake | pj
brief DEMO-42; engine stage end intake | pj
engine pack validate --pack packs/example/stack.yaml | packs
