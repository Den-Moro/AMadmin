-- Магазин — главная единица группировки касс: страница «Магазины» (карточки с цветом
-- состояния) и страница самого магазина с его кассами. Заменяет «Узлы» (network_sites):
-- узел по сути пытался быть магазином. Полезное из узлов переезжает в магазин —
-- подсети (CIDR через запятую) и пороги цвета (те же ключи
-- network_site_status_green_min_percent / red_max_percent).
--
-- Подсети ничего не переносят молча: по IP последнего опроса панель подсказывает, какие
-- кассы, похоже, стоят в этом магазине, и раскладывает их по кнопке — с подтверждением.
ALTER TABLE stores ADD COLUMN subnets TEXT;

-- Если узел назывался так же, как магазин, его подсеть переходит магазину.
UPDATE stores
SET subnets = (SELECT ns.cidr FROM network_sites ns WHERE ns.name = stores.name AND ns.cidr IS NOT NULL ORDER BY ns.priority DESC LIMIT 1)
WHERE subnets IS NULL;

-- Таблицы network_sites / network_site_members панель больше не использует. Не удаляем,
-- чтобы обновление не уничтожало данные; их можно удалить вручную.
