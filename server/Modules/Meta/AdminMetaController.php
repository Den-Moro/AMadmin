<?php

// Списки для дропдаунов таргетинга в форме создания оповещения (магазины/типы устройств).
// Группы хостов сюда не входят — для них есть свой CRUD, см. AdminHostGroupsController::index
// (те же id/name, плюс member_count, поэтому используется и как источник для дропдауна).
// Отдельных CRUD-экранов для магазинов/типов устройств пока нет (см. AGENTS.md,
// "Справочники") — это следующий шаг, пока только чтение.
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
}
