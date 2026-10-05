SELECT
	mo.Description
	,mo.FleetID
	,mo.MinDistance
	,mt.MaxRange
	,s.ShipClassID
	,sw.*
	,mt.*
	,mo.*
FROM
	FCT_MoveOrders as mo
inner JOIN
	FCT_Ship as s
on
	s.FleetID = mo.FleetID
inner JOIN
	FCT_ShipWeapon as sw
on
	sw.ShipID = s.ShipID
inner JOIN
	FCT_MissileType as mt
on
	mt.MissileID = sw.MissileID
WHERE
	mo.GameID = 117
AND
	mo.RaceID <> 607
AND
	mo.MoveActionID = 39
AND
	mt.Name not like '%decoy'
order by
	sw.ShipID, sw.MissileID
	
--delete from FCT_MoveOrders where MoveOrderID = 39766601
