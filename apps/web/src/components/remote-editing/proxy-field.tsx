import { useCallback, type HTMLAttributes, type Ref } from "react";

export type RemoteProxyElement = HTMLTextAreaElement | HTMLInputElement;
export function ProxyField({
  sensitive,
  ref,
  ...props
}: HTMLAttributes<RemoteProxyElement> & {
  readonly sensitive: boolean;
  readonly ref?: Ref<RemoteProxyElement>;
  readonly disabled?: boolean;
  readonly autoComplete?: string;
  readonly autoFocus?: boolean;
}) {
  const assign = useCallback(
    (element: RemoteProxyElement | null) => {
      if (typeof ref === "function") return ref(element);
      if (ref) ref.current = element;
    },
    [ref],
  );
  // An explicit empty form owner excludes ancestor forms and their autofill policy.
  return sensitive ? (
    <input {...props} id={undefined} name={undefined} form="" ref={assign} type="password" />
  ) : (
    <textarea {...props} id={undefined} name={undefined} form="" ref={assign} />
  );
}
