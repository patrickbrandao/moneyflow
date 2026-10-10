-- migrate:up

-- Plano global de categorias (spec 008): receita/despesa, dois níveis. -----------
CREATE TABLE categories (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind        text        NOT NULL,
  parent_id   uuid        REFERENCES categories (id),
  name        text        NOT NULL,
  color       text,
  icon        text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_kind_check CHECK (kind IN ('income', 'expense')),
  CONSTRAINT categories_name_check CHECK (btrim(name) <> '' AND name = btrim(name)),
  CONSTRAINT categories_parent_self_check CHECK (parent_id <> id),
  CONSTRAINT categories_color_check CHECK (color IN (
    'slate', 'gray', 'zinc', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green',
    'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose')),
  CONSTRAINT categories_icon_check CHECK (icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE INDEX categories_parent_id_idx ON categories (parent_id);
-- Nome único entre irmãos, sem distinção de maiúsculas (grupos: por kind; subcategorias: por grupo).
CREATE UNIQUE INDEX categories_sibling_name_key ON categories (kind, parent_id, lower(name)) NULLS NOT DISTINCT;

CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Dois níveis no máximo; filho com o mesmo kind do pai; kind imutável.
CREATE FUNCTION categories_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'categories: kind cannot change (category %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_kind_immutable_check';
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    -- FOR SHARE bloqueia o pai contra uma mudança concorrente de parent_id.
    SELECT c.kind, c.parent_id INTO parent
      FROM categories c WHERE c.id = NEW.parent_id FOR SHARE;

    IF FOUND THEN
      IF parent.parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'categories: parent % is already a subcategory (max two levels)', NEW.parent_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth_check';
      END IF;
      IF parent.kind <> NEW.kind THEN
        RAISE EXCEPTION 'categories: kind % differs from parent kind %', NEW.kind, parent.kind
          USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_parent_kind_check';
      END IF;
    END IF;  -- pai inexistente: a FK reporta o erro.

    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'categories: % has subcategories and cannot become a subcategory', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER categories_validate BEFORE INSERT OR UPDATE OF kind, parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION categories_validate();

COMMENT ON TABLE categories IS
  'Plano global de categorias: grupo (parent_id nulo) → subcategoria. Dois níveis, filho com o kind do pai.';
COMMENT ON COLUMN categories.kind IS 'income (receita) ou expense (despesa). Imutável após a criação.';
COMMENT ON COLUMN categories.color IS 'Nome de cor da paleta do Tailwind (ex.: violet), não hex: o front mapeia para tokens.';
COMMENT ON COLUMN categories.icon IS 'Nome de ícone lucide em kebab-case (ex.: shopping-cart).';

-- Categorias ocultas por caixa ----------------------------------------------------------
CREATE TABLE caixa_hidden_categories (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  caixa_id    uuid        NOT NULL REFERENCES caixas (id) ON DELETE CASCADE,
  category_id uuid        NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT caixa_hidden_categories_key UNIQUE (caixa_id, category_id)
);

CREATE INDEX caixa_hidden_categories_category_id_idx ON caixa_hidden_categories (category_id);

CREATE TRIGGER caixa_hidden_categories_set_updated_at BEFORE UPDATE ON caixa_hidden_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE caixa_hidden_categories IS
  'Categorias que uma caixa oculta das suas listas. Ocultar um grupo não cria linhas para os filhos (a aplicação herda).';

-- migrate:down

DROP TABLE caixa_hidden_categories;
DROP TABLE categories;
DROP FUNCTION categories_validate();
