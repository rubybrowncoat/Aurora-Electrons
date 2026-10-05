SELECT
	dc.*
	,sdc.*
FROM
	FCT_Fleet as f
inner JOIN	FCT_Ship as s on s.FleetID = f.FleetID
inner join	FCT_DamagedComponent as dc on dc.ShipID = s.ShipID
inner join	FCT_ShipDesignComponents as sdc on sdc.SDComponentID = dc.ComponentID
--inner join	FCT_ClassComponent as cc on cc.ComponentID = dc.ComponentID
where
	f.SystemID = 21803