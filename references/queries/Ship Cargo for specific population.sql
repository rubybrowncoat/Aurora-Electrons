select
	mo.fleetid, sc.*
FROM
	FCT_MoveOrders as mo
--inner join FCT_Fleet as f on f.FleetID = mo.FleetID
inner join FCT_Ship as s on s.FleetID = mo.FleetID
inner join FCT_ShipCargo as sc on sc.ShipID = s.ShipID
WHERE
	mo.PopulationID = 17221