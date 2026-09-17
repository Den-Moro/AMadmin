<?php

// Списки для дропдаунов таргетинга в форме создания оповещения (магазины/группы/типы
// устройств) — отдельных CRUD-экранов для них ещё нет (см. AGENTS.md, "Справочники",
// это следующий шаг), пока только чтение.
class AdminMetaController
{
    public static function stores()
    {
        AdminAuth::requireLogin();
        echo json_encode(Db::get()->query('SELECT id, name, is_pilot FROM stores ORDER BY name')->fetchAll());
    }

    public static function deviceTypes()
    {
        AdminAuth::requireLogin();
        echo json_encode(Db::get()->query('SELECT id, name FROM device_types ORDER BY name')->fetchAll());
    }

    public static function hostGroups()
    {
        AdminAuth::requireLogin();
        echo json_encode(Db::get()->query('SELECT id, name FROM host_groups ORDER BY name')->fetchAll());
    }
}
