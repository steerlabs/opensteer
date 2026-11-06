import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { WorkspaceSummary } from "@opensteer/client/host";
import { BrandMark } from "./brand.js";
import { composerFold } from "./fold-to-fit.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { WorkspaceOrb } from "./workspace-orb.js";

/**
 * Who should do the task being written: Opensteer, in Main, or one of the
 * reader's projects. Each one starts tasks from its own page, so choosing
 * goes there; with no project there is nothing to choose and nothing shows.
 */
export function AssigneePicker({
  draftId,
  projects,
  workspace,
}: {
  /** The draft being written: it goes with the choice, words and all. */
  readonly draftId: string;
  readonly projects: readonly WorkspaceSummary[];
  /** The Workspace the composer on screen starts its task in. */
  readonly workspace: WorkspaceSummary;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  if (projects.length === 0) return null;
  const main = workspace.kind === "main";
  const name = main ? "Opensteer" : workspace.name;
  const choose = (path: string) => {
    setOpen(false);
    void navigate(`${path}?draft=${encodeURIComponent(draftId)}`);
  };
  return (
    <div className="assignee">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Who should do it: ${name}`}
        className="assignee__button"
        onClick={() => setOpen((value) => !value)}
        ref={anchorRef}
        type="button"
      >
        {main ? (
          <BrandMark />
        ) : (
          <WorkspaceOrb
            icon={workspace.icon}
            name={workspace.name}
            size="tiny"
            color={workspace.color}
          />
        )}
        <span className="assignee__name" data-fold={composerFold.assignee}>
          {name}
        </span>
        <Icon data-fold={composerFold.assignee} name="chevron-down" />
      </button>
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="assignee-popover"
          label="Who should do it?"
          onClose={() => setOpen(false)}
        >
          <div className="picker__section">
            <button
              aria-checked={main}
              className="picker__row"
              onClick={() => choose("/new")}
              role="menuitemradio"
              type="button"
            >
              <span className="picker__check">{main ? <Icon name="check" /> : null}</span>
              <span className="picker__glyph">
                <BrandMark />
              </span>
              <span className="picker__label-stack">
                <span className="picker__label">Opensteer</span>
                <span className="picker__detail">Works on anything</span>
              </span>
            </button>
            {projects.map((project) => {
              const selected = project.id === workspace.id;
              return (
                <button
                  aria-checked={selected}
                  className="picker__row"
                  key={project.id}
                  onClick={() => choose(`/workspaces/${encodeURIComponent(project.id)}`)}
                  role="menuitemradio"
                  type="button"
                >
                  <span className="picker__check">{selected ? <Icon name="check" /> : null}</span>
                  <span className="picker__glyph">
                    <WorkspaceOrb
                      icon={project.icon}
                      name={project.name}
                      size="tiny"
                      color={project.color}
                    />
                  </span>
                  <span className="picker__label-stack">
                    <span className="picker__label">{project.name}</span>
                    {project.description ? (
                      <span className="picker__detail">{project.description}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
