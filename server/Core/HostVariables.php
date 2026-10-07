<?php

// Переменные хоста (бета, только superadmin) — см. миграцию 028.
//
// Значение для конкретной кассы берётся с самого узкого уровня: касса > группа >
// магазин > все кассы. Если одно имя задано в нескольких группах кассы — побеждает
// группа, первая по алфавиту (страница переменных показывает, откуда взято значение).
//
// В текст скрипта, путь файла и значение переменной среды они попадают как {{ИМЯ}} —
// сервер подставляет их для каждой кассы отдельно в момент выдачи команды
// (CommandsController::index), сама команда в базе хранится с {{ИМЯ}}.
class HostVariables
{
    // Имя: латиница, цифры, подчёркивание, с буквы или подчёркивания — как у переменных
    // в скриптах, чтобы {{ИМЯ}} однозначно читался в любом тексте.
    const NAME_PATTERN = '/^[A-Za-z_][A-Za-z0-9_]{0,63}$/';
    const PLACEHOLDER = '/\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/';

    const SCOPE_RANK = array('global' => 1, 'store' => 2, 'group' => 3, 'pc' => 4);

    public static function hasPlaceholders($text)
    {
        return is_string($text) && preg_match(self::PLACEHOLDER, $text) === 1;
    }

    // Действующие переменные одной кассы: array(имя_в_нижнем_регистре => array(name,
    // value, is_secret, scope, scope_id, scope_name)). $staticGroupsOnly — для условий
    // смарт-групп: переменные самих смарт-групп там не учитываются, иначе состав группы
    // зависел бы от переменных, которые зависят от состава.
    public static function effective($pcId, $storeId, $staticGroupsOnly = false)
    {
        $groupFilter = $staticGroupsOnly ? " AND g.kind = 'static'" : '';
        $stmt = Db::get()->prepare("
            SELECT v.name, v.value, v.is_secret, v.scope, v.scope_id,
                   CASE v.scope
                       WHEN 'store' THEN (SELECT name FROM stores WHERE id = v.scope_id)
                       WHEN 'pc' THEN (SELECT COALESCE(NULLIF(display_name, ''), hostname) FROM pcs WHERE id = v.scope_id)
                       ELSE g.name
                   END AS scope_name
            FROM host_variables v
            LEFT JOIN host_groups g ON v.scope = 'group' AND g.id = v.scope_id
            WHERE v.scope = 'global'
               OR (v.scope = 'store' AND v.scope_id = :store_id)
               OR (v.scope = 'pc' AND v.scope_id = :pc_id)
               OR (v.scope = 'group' AND v.scope_id IN (SELECT group_id FROM host_group_members WHERE pc_id = :member_pc_id){$groupFilter})
        ");
        $stmt->execute(array('store_id' => (int) $storeId, 'pc_id' => (int) $pcId, 'member_pc_id' => (int) $pcId));

        return self::resolve($stmt->fetchAll());
    }

    // Из строк всех подходящих уровней — по одной на имя, с самого узкого уровня.
    public static function resolve(array $rows)
    {
        usort($rows, function ($a, $b) {
            $ra = HostVariables::SCOPE_RANK[$a['scope']];
            $rb = HostVariables::SCOPE_RANK[$b['scope']];
            if ($ra !== $rb) {
                return $ra - $rb;
            }
            // Среди групп побеждает первая по алфавиту — она должна идти последней.
            return strcmp((string) $b['scope_name'], (string) $a['scope_name']);
        });
        $vars = array();
        foreach ($rows as $row) {
            $vars[strtolower($row['name'])] = array(
                'name'       => $row['name'],
                'value'      => (string) $row['value'],
                'is_secret'  => (int) $row['is_secret'],
                'scope'      => $row['scope'],
                'scope_id'   => $row['scope_id'] !== null ? (int) $row['scope_id'] : null,
                'scope_name' => isset($row['scope_name']) ? $row['scope_name'] : null,
            );
        }
        return $vars;
    }

    // Подставляет {{ИМЯ}}. Имена, которых у кассы нет, остаются как есть и попадают в
    // $missing — вызывающий решает, что с этим делать (команда не выполняется).
    public static function render($text, array $vars, array &$missing)
    {
        if (!is_string($text) || $text === '') {
            return $text;
        }
        return preg_replace_callback(self::PLACEHOLDER, function ($m) use ($vars, &$missing) {
            $key = strtolower($m[1]);
            if (!isset($vars[$key])) {
                $missing[$m[1]] = true;
                return $m[0];
            }
            return $vars[$key]['value'];
        }, $text);
    }
}
