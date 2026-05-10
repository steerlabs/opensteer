from importlib import resources
from pathlib import Path
import shutil


DEFAULT_TARGETS = (
    Path.home() / ".codex" / "skills" / "opensteer",
    Path.home() / ".claude" / "skills" / "opensteer",
    Path.home() / ".agents" / "skills" / "opensteer",
)


def _copy_tree(src, dest):
    dest.mkdir(parents=True, exist_ok=True)
    skill = dest / "SKILL.md"
    if skill.exists() or skill.is_symlink():
        skill.unlink()
    interactions = dest / "interaction-skills"
    if interactions.exists() or interactions.is_symlink():
        if interactions.is_dir() and not interactions.is_symlink():
            shutil.rmtree(interactions)
        else:
            interactions.unlink()
    shutil.copytree(src, dest, dirs_exist_ok=True)


def install_skills(targets=None, out=print):
    """Install Opensteer's generic agent skills into common global skill paths."""
    selected = tuple(Path(p).expanduser() for p in (targets or DEFAULT_TARGETS))
    source = resources.files("opensteer").joinpath("agent_skills")
    with resources.as_file(source) as src:
        for dest in selected:
            _copy_tree(src, dest)
            out(f"installed {dest}")
    return selected
