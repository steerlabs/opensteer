/**
 * How the first-run journey passes the setup steps before the phone: each step by its own title
 * (the one heading a setup screen shows, `setup-frame.tsx`) and the move that step offers a person
 * who leaves it as it is, never by a button another step also shows. `setup-walk.test.ts` holds
 * these to the steps' own source and order.
 */
export const setupMoves: Readonly<Record<string, string>> = {
  // `setup-ai-step.tsx`: Skip, the setup footer's own word.
  "Your AI": "Skip",
  // `devices/home-setup-step.tsx`: only Continue, which leads to "Let macOS allow it".
  "Your agent on this Mac": "Continue",
  "Let macOS allow it": "Do this later",
};

/** Where the walk ends: the phone step. */
export const phoneStepTitle = "Connect your phone";
