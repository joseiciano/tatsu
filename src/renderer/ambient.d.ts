// React 19 scopes JSX under React.JSX. The codebase uses the bare
// `JSX.Element` annotation in many places; re-expose it globally so those
// references resolve without touching every component.
import type { JSX as ReactJSX } from 'react'

declare global {
  interface Window {
    /** @deprecated Use __TATSU_WEB__ */
    __HARNESS_WEB__?: boolean
    /** @deprecated Use __TATSU_PLATFORM__ */
    __HARNESS_PLATFORM__?: NodeJS.Platform
    __TATSU_WEB__?: boolean
    __TATSU_PLATFORM__?: NodeJS.Platform
    /** @deprecated Use __tatsu_local_transport */
    __harness_local_transport?: import('../../shared/transport/transport').LocalTransportHandle
    /** @deprecated Use __tatsu_electron_helpers */
    __harness_electron_helpers?: import('../../shared/transport/transport').ElectronOnlyHelpers
    __tatsu_local_transport?: import('../../shared/transport/transport').LocalTransportHandle
    __tatsu_electron_helpers?: import('../../shared/transport/transport').ElectronOnlyHelpers
  }
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementType = ReactJSX.ElementType
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
  }
}
