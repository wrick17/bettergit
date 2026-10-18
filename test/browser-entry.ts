// Bundled by browser.test.ts for a real Chromium page: the pieces whose behaviour depends on layout or live DOM.
import { EditorState, EditorSelection } from '@codemirror/state'
import { bufferedKey, lineColumnAt } from '../src/renderer/src/DiffEditor'
import { setFindQuery, watchFind } from '../src/renderer/src/find'
import { typeKeys } from '../src/renderer/src/cm-editor'

Object.assign(window, {
  under: { bufferedKey, lineColumnAt, setFindQuery, watchFind, typeKeys, EditorState, EditorSelection },
})
