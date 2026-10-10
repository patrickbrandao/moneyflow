-- migrate:up

-- Cor da categoria passa a ser um slot do design system (1–12), que o front
-- mapeia para o token CSS --port-N. Substitui o nome de paleta do Tailwind.
ALTER TABLE categories ADD COLUMN color_slot smallint;

-- Conversão dos valores existentes por proximidade de matiz.
UPDATE categories SET color_slot = CASE color
  WHEN 'red'     THEN 1  WHEN 'rose'   THEN 1
  WHEN 'orange'  THEN 2
  WHEN 'amber'   THEN 3  WHEN 'yellow' THEN 3
  WHEN 'lime'    THEN 4
  WHEN 'green'   THEN 5  WHEN 'emerald' THEN 5
  WHEN 'teal'    THEN 6
  WHEN 'cyan'    THEN 7  WHEN 'sky'    THEN 7
  WHEN 'blue'    THEN 8
  WHEN 'indigo'  THEN 9
  WHEN 'violet'  THEN 10 WHEN 'purple' THEN 10
  WHEN 'fuchsia' THEN 11 WHEN 'pink'   THEN 11
  WHEN 'slate'   THEN 12 WHEN 'gray'   THEN 12 WHEN 'zinc' THEN 12 WHEN 'stone' THEN 12
END
WHERE color IS NOT NULL;

ALTER TABLE categories
  DROP COLUMN color,
  ADD CONSTRAINT categories_color_slot_check CHECK (color_slot BETWEEN 1 AND 12);

COMMENT ON COLUMN categories.color_slot IS
  'Slot de cor do design system (1–12); o front mapeia para o token CSS --port-N. Nulo = cor neutra.';

-- migrate:down

ALTER TABLE categories ADD COLUMN color text;

UPDATE categories
   SET color = (ARRAY['red', 'orange', 'amber', 'lime', 'green', 'teal',
                      'cyan', 'blue', 'indigo', 'violet', 'pink', 'slate'])[color_slot]
 WHERE color_slot IS NOT NULL;

ALTER TABLE categories
  DROP COLUMN color_slot,
  ADD CONSTRAINT categories_color_check CHECK (color IN (
    'slate', 'gray', 'zinc', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green',
    'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'));

COMMENT ON COLUMN categories.color IS 'Nome de cor da paleta do Tailwind (ex.: violet), não hex: o front mapeia para tokens.';
