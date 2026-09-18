<?php

// Общее условие "относится ли occurrence к этому ПК" (all / его магазин / его группа /
// он сам / его тип устройства). Используется и в списке активных оповещений
// (OccurrencesController), и при проверке права на ack (AckController) — вынесено сюда,
// чтобы логика таргетинга не могла разъехаться между двумя местами при будущих правках.
class TargetMatcher
{
    const JOIN = "
        LEFT JOIN host_group_members hgm ON hgm.pc_id = :pc_id AND hgm.group_id = t.target_id
    ";

    const CONDITION = "
        (
            t.target_type = 'all'
            OR (t.target_type = 'store' AND t.target_id = :store_id)
            OR (t.target_type = 'pc' AND t.target_id = :target_pc_id)
            OR (t.target_type = 'device_type' AND t.target_id = :device_type_id)
            OR (t.target_type = 'group' AND hgm.pc_id IS NOT NULL)
        )
    ";

    public static function params($pc)
    {
        return array(
            'pc_id'          => $pc['id'],
            'store_id'       => $pc['store_id'],
            'target_pc_id'   => $pc['id'],
            'device_type_id' => $pc['device_type_id'],
        );
    }
}
