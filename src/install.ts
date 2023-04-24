import { createStore } from './createStore'
import { defaultSymbol, userSymbols } from './symbols'
import type { Plugin, InjectionKey } from 'vue'
import type { PluginOptions, Store, PushFn } from './types'

declare module 'vue' {
   interface ComponentCustomProperties {
      $push: PushFn
   }
}

export const install: Plugin = {
   install(
      app,
      { register = [] }: PluginOptions = {
         register: [],
      }
   ) {
      register.forEach((key) => (userSymbols[key.toString()] = Symbol(key.toString())))

      const receivers = new Map<InjectionKey<Store>, Store>()

      Object.values(userSymbols)
         .concat(defaultSymbol)
         .forEach((sym) => receivers.set(sym, createStore()))

      receivers.forEach((value, sym) => app.provide(sym, value))

      if (!app.config.globalProperties.$push && receivers.get(defaultSymbol)) {
         app.config.globalProperties.$push = receivers.get(defaultSymbol)!.push
      }
   },
}