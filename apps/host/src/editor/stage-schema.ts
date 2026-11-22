import type { ConfigField } from '@perspectra/world-pack/editor-config'
import { componentStyle, stageComponents } from '../runtime/pack-components.ts'

const text: ConfigField = { type: 'string' },
  fraction: ConfigField = { type: 'number', minimum: 0, maximum: 1 }
const object = (properties: Record<string, ConfigField>, required: string[] = []): ConfigField => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const dictionary = (additionalProperties: ConfigField): ConfigField => ({ type: 'object', additionalProperties })
const box: ConfigField = {
  type: 'array',
  prefixItems: ['左', '上', '宽', '高'].map(title => ({ ...fraction, title })),
  default: [0, 0, 1, 1],
  minItems: 4,
  maxItems: 4,
}
const dimension: ConfigField = { type: 'integer', minimum: 1, maximum: 16, default: 4 }
const character = object({
  framing: { ...object({ top: fraction, waist: fraction }, ['top', 'waist']), default: { top: 0.03, waist: 0.48 } },
  face: box,
  sheets: dictionary({
    oneOf: [
      { ...text, title: '默认四行四列' },
      { ...object({ image: text, columns: dimension, rows: dimension }, ['image']), title: '自定行列' },
    ],
  }),
  expressions: dictionary({
    oneOf: [
      { ...text, title: '整张透明图层' },
      { ...object({ image: text, at: box }, ['image']), title: '局部图片' },
      {
        ...object({ sheet: text, cell: { type: 'integer', minimum: 0 }, at: box }, ['sheet', 'cell']),
        title: '拼合图中的一格',
      },
    ],
  }),
  defaultExpression: text,
  poses: dictionary(text),
})
export const stageSchema = object(
  {
    characters: dictionary(character),
    autoplay: object({ activity: text, operation: text }, ['activity', 'operation']),
  },
  ['characters'],
)
export const componentsSchema = object(
  {
    version: { const: 1 },
    components: object(
      Object.fromEntries(
        stageComponents.map(id => {
          const { choices, movable, renameable } = componentStyle(id)
          const fields: Record<string, ConfigField> = Object.fromEntries(
            Object.entries(choices).map(([key, values]) => [key, { type: 'string', enum: [...values] }]),
          )
          if (movable) fields.order = { type: 'integer', minimum: 0, maximum: 9 }
          if (renameable) fields.label = { type: 'string', minLength: 1, maxLength: 6 }
          return [id, object({ ...fields, narrow: object(fields) })]
        }),
      ),
    ),
  },
  ['version', 'components'],
)
