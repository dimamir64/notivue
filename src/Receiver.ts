import {
   Teleport,
   defineComponent,
   ref,
   computed,
   watch,
   watchEffect,
   h,
   toRef,
   nextTick,
   type PropType,
} from 'vue'
import { useStore } from './useStore'
import { staticStyles, useDynamicStyles } from './useStyles'
import { useRefsMap } from './useRefsMap'
import { useResizeObserver } from './useResizeObserver'
import { useWindowSize } from './useWindowSize'
import { defaultOptions } from './options'
import { ariaLive } from './ariaLive'
import { mergeOptions, getDefaultAnims } from './utils'
import {
   FIXED_INCREMENT,
   COMPONENT_NAME,
   NotificationType as NType,
   TransitionTypes as TType,
} from './constants'
import type {
   ReceiverProps as Props,
   StoreItem,
   MergedOptions,
   MaybeRenderStatic,
   MaybeRenderPromiseResult,
   CtxProps,
} from './types'

export const Receiver = defineComponent({
   name: COMPONENT_NAME,
   inheritAttrs: false,
   props: {
      id: {
         type: String as PropType<Props['id']>,
         default: '',
      },
      class: {
         type: String as PropType<Props['class']>,
         default: '',
      },
      pauseOnHover: {
         type: Boolean as PropType<Props['pauseOnHover']>,
         default: true,
      },
      position: {
         type: String as PropType<Props['position']>,
         default: 'top-center',
      },
      options: {
         type: Object as PropType<Props['options']>,
         default: () => ({}),
      },
      animations: {
         type: Object as PropType<Props['animations']>,
         default: () => ({}),
      },
      use: {
         type: Function as PropType<Props['use']>,
         default: () => null,
      },
      theme: {
         type: Object as PropType<Props['theme']>,
         default: undefined,
      },
      icons: {
         type: Object as PropType<Props['icons']>,
         default: undefined,
      },
   },
   setup(props) {
      // Reactivity - Props

      const position = toRef(props, 'position')
      const pauseOnHover = toRef(props, 'pauseOnHover')
      const animations = toRef(props, 'animations')

      const isTop = computed(() => position.value.startsWith('top'))

      const mergedAnims = computed(() => ({
         ...getDefaultAnims(isTop.value),
         ...animations.value,
      }))

      // Reactivity - Store

      const {
         items,
         incoming,
         clearAllScheduler,
         isEnabled,
         hasItems,
         createItem,
         getItem,
         updateItem,
         removeItem,
         destroyAll,
         updateAll,
      } = useStore(props.id)

      // Reactivity - Elements and styles

      const wrapperRef = ref<HTMLElement>()

      const { refs, sortedIds, setRefs } = useRefsMap()

      const dynamicStyles = useDynamicStyles(position)

      // Non-reactive

      let isHovering = false

      // Watchers - Resize and positioning

      watch(isTop, () => setPositions(TType.SILENT))

      useWindowSize(() => setPositions(TType.SILENT))

      const resizeObserver = useResizeObserver(() => setPositions(TType.HEIGHT))

      watch(
         () => items.value.filter(({ type }) => type === NType.PROMISE).map(({ id }) => id),
         (newPromises) => {
            if (newPromises.length > 0) {
               newPromises.forEach((id) =>
                  resizeObserver.value?.observe(refs.get(id) as HTMLElement)
               )
            }
         },
         { flush: 'post' }
      )

      // Watchers - Clear All

      watch(clearAllScheduler, () => {
         if (hasItems.value) {
            animateClearAll()
         }
      })

      // Watchers - Hover

      watch(
         () => !hasItems.value,
         (isEmpty) => {
            if (isEmpty) {
               isHovering = false
            }
         }, // watchPostEffect unsupported < 3.2.0
         { flush: 'post' }
      )

      // Watchers - Notifications

      let detachListener: ReturnType<typeof attachListener>

      watchEffect(() => {
         if (!isEnabled.value && detachListener) {
            detachListener()
            destroyAll()
         } else {
            detachListener = attachListener()
         }
      })

      function attachListener() {
         return watch(incoming, (pushOptions) => {
            const createdAt = performance.now()
            const options = mergeOptions(defaultOptions, props.options, pushOptions)

            let customRenderer: Partial<
               Pick<StoreItem, 'prevProps' | 'prevComponent' | 'customComponent'>
            > = {
               customComponent: undefined,
            }

            if (
               options.type.includes(NType.PROMISE_REJECT) ||
               options.type.includes(NType.PROMISE_RESOLVE)
            ) {
               const currItem = getItem(options.id)
               const prevComponent = currItem?.prevComponent

               if (prevComponent) {
                  const prevProps = { ...(currItem.prevProps ?? {}) }

                  delete prevProps.message
                  delete prevProps.type
                  delete prevProps.duration
                  delete prevProps.clear

                  const newComponent = options.render?.component
                  const newProps = { ...getCtxProps(options), prevProps }

                  customRenderer = {
                     customComponent: () =>
                        h(
                           newComponent ? newComponent() : prevComponent(),
                           (
                              options.render?.props as NonNullable<
                                 MaybeRenderPromiseResult['render']
                              >['props']
                           )?.(newProps) ?? {}
                        ),
                  }
               }

               updateItem(options.id, {
                  ...options,
                  ...customRenderer,
                  createdAt,
                  timeoutId: isHovering ? undefined : createTimeout(options.id, options.duration),
               })
            } else {
               const _customComponent = options.render?.component

               if (_customComponent) {
                  const props = ((
                     options.render?.props as NonNullable<
                        MaybeRenderStatic<CtxProps & Record<string, unknown>>['render']
                     >['props']
                  )?.(getCtxProps(options)) ?? {}) as CtxProps

                  customRenderer = {
                     customComponent: () => h(_customComponent(), props),
                     ...(options.type === NType.PROMISE
                        ? { prevProps: props, prevComponent: _customComponent }
                        : {}),
                  }
               }

               createItem({
                  ...options,
                  ...customRenderer,
                  createdAt,
                  timeoutId:
                     options.duration === Infinity
                        ? undefined
                        : createTimeout(options.id, options.duration),
                  /**
                   * These methods are an exception and the only ones created
                   * here that mutates the store as they rely too much on the
                   * component instance.
                   */
                  clear: () => animateLeave(options.id),
                  destroy: () => {
                     removeItem(options.id)
                     setPositions()
                  },
               })

               nextTick(() => animateEnter(options.id))
            }
         })
      }

      function createTimeout(id: string, time: number) {
         return window.setTimeout(() => animateLeave(id), time)
      }

      function getCtxProps({ message, type, duration, id }: MergedOptions) {
         return { notivueProps: { message, type, duration, clear: () => animateLeave(id) } }
      }

      // Transitions

      function setPositions(type: TType = TType.PUSH) {
         const factor = isTop.value ? 1 : -1

         let accPrevHeights = 0

         for (const id of sortedIds.value) {
            const thisEl = refs.get(id)
            const thisItem = getItem(id)

            if (!thisEl || !thisItem || thisItem.animationClass === mergedAnims.value.leave) {
               continue
            }

            updateItem(id, {
               transitionStyles: {
                  ...(type === TType.HEIGHT ? { transitionProperty: 'all' } : {}),
                  ...(type === TType.SILENT ? { transition: 'none' } : {}),
                  transform: `translate3d(0, ${accPrevHeights}px, 0)`,
               },
            })

            accPrevHeights += factor * thisEl.clientHeight
         }
      }

      // Animations

      function animateItem(id: string, className: string, onEnd: () => void) {
         updateItem(id, {
            animationClass: className,
            onAnimationstart: (event: AnimationEvent) => event.stopPropagation(),
            onAnimationend: (event: AnimationEvent) => {
               event.stopPropagation()
               onEnd()
            },
         })
      }

      function animateEnter(id: string) {
         animateItem(id, mergedAnims.value.enter, () =>
            updateItem(id, { animationClass: '', onAnimationend: undefined })
         )
         setPositions()
      }

      function animateLeave(id: string) {
         animateItem(id, mergedAnims.value.leave, () => removeItem(id))
         setPositions()
      }

      function animateClearAll() {
         if (wrapperRef.value) {
            wrapperRef.value.classList.add(mergedAnims.value.clearAll)
            wrapperRef.value.onanimationend = () => {
               destroyAll()
            }
         }
      }

      // Props

      const pointerEvents = {
         onPointerenter() {
            if (hasItems.value && !isHovering) {
               isHovering = true

               const stoppedAt = performance.now()

               updateAll((item) => {
                  clearTimeout(item.timeoutId)

                  return {
                     ...item,
                     stoppedAt,
                     elapsed: stoppedAt - item.createdAt + (item.elapsed ?? 0),
                  }
               })
            }
         },
         onPointerleave() {
            if (hasItems.value && isHovering) {
               updateAll((item) => {
                  const newTimeout = item.duration + FIXED_INCREMENT - (item.elapsed ?? 0)

                  return {
                     ...item,
                     createdAt: performance.now(),
                     timeoutId:
                        item.duration === Infinity ? undefined : createTimeout(item.id, newTimeout),
                  }
               })

               isHovering = false
            }
         },
      }

      // Render

      return () =>
         h(Teleport, { to: 'body' }, [
            items.value.length > 0 &&
               h(
                  'div',
                  {
                     ref: wrapperRef,
                     style: staticStyles.wrapper,
                     class: props.class,
                  },
                  h(
                     'div',
                     {
                        style: staticStyles.container,
                        ...(pauseOnHover.value ? pointerEvents : {}),
                     },
                     items.value.map((item) =>
                        h(
                           'div',
                           {
                              key: item.id,
                              ref: (_ref) => setRefs(_ref as HTMLElement | null, item.id),
                              style: {
                                 ...staticStyles.row,
                                 ...dynamicStyles.value.row,
                                 ...item.transitionStyles,
                              },
                           },
                           h(
                              'div',
                              {
                                 style: {
                                    ...staticStyles.box,
                                    ...dynamicStyles.value.box,
                                 },
                                 class: item.animationClass,
                                 onAnimationstart: item.onAnimationstart,
                                 onAnimationend: item.onAnimationend,
                              },
                              [
                                 item.customComponent?.() ??
                                    props.use(item, props.theme, props.icons),
                                 ariaLive(item),
                              ]
                           )
                        )
                     )
                  )
               ),
         ])
   },
})
