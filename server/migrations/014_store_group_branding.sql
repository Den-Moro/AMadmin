-- Свой бренд/контакт для магазина или группы хостов — переопределяет глобальный
-- brand_name/brand_contact (settings) в оповещениях на кассах этого магазина/группы.
-- Пусто — наследуется глобальное значение (см. OccurrencesController::resolveBrand).
ALTER TABLE stores ADD COLUMN brand_name TEXT;
ALTER TABLE stores ADD COLUMN brand_contact TEXT;
ALTER TABLE host_groups ADD COLUMN brand_name TEXT;
ALTER TABLE host_groups ADD COLUMN brand_contact TEXT;
