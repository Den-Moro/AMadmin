-- «Узлы» — хосты на одной локальной сети, определяются по last_ip через CIDR-правило
-- узла с приоритетом (более специфичная подсеть должна побеждать более широкую).
-- Отдельные таблицы, не host_groups: там членство исключительно ручное и уже служит
-- таргетингом для оповещений/команд — авто-пересчёт по IP рисковал бы затереть
-- вручную скомплектованную группу. PRIMARY KEY(pc_id) — у хоста только один узел
-- (он физически подключён к одной локальной сети одновременно).
CREATE TABLE network_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cidr TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE network_site_members (
    site_id INTEGER NOT NULL REFERENCES network_sites (id) ON DELETE CASCADE,
    pc_id INTEGER NOT NULL REFERENCES pcs (id) ON DELETE CASCADE,
    -- 1 = назначено вручную (drag-n-drop/добавление), авто-пересчёт такие не трогает.
    manual INTEGER NOT NULL DEFAULT 0,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pc_id)
);

CREATE INDEX idx_network_sites_priority ON network_sites (priority DESC);
CREATE INDEX idx_network_site_members_site_id ON network_site_members (site_id);

-- Пороги статуса узла — настраиваются на самой вкладке «Узлы» (только суперадмин).
INSERT INTO settings (key, value) VALUES
    ('network_site_status_green_min_percent', '100'),
    ('network_site_status_red_max_percent', '0');
