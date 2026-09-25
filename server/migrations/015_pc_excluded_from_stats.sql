-- Хост можно исключить из статистики (дашборд, версии агента), не убирая его
-- из списка «Хосты» — например, касса планово выключена на ремонт магазина и
-- не должна портить общий процент "офлайн".
ALTER TABLE pcs ADD COLUMN excluded_from_stats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pcs ADD COLUMN excluded_reason TEXT;
