/**
 * `update_home` as opensteer-home calls it (`update_home … || update_status=$?`): errexit is off
 * inside, exactly as in production. Every test of the update path calls it through this, so no
 * test can pass on errexit doing what the updater must do itself.
 */
export function asOpensteerHomeCallsUpdate(args: string): string {
  return `update_home ${args} || exit $?`;
}
