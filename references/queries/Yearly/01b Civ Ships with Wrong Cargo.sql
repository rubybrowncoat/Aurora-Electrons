with CTE_Fleets as
(
SELECT
	f.FleetName
	,mo.Description
	,mo_load.Description as LoadDescription
	,mo.DestinationItemID
	,sc.CargoTypeID
	,sc.CargoID
	,sc.ShipID
	,mo.*
FROM
	vw_const as c
inner JOIN
	fct_fleet as f
on
	f.GameID = c.GameID
--and
--	f.RaceID = c.RaceID
inner JOIN
	FCT_MoveOrders as mo
on
	mo.FleetID = f.FleetID
inner JOIN	fct_ship as s on s.FleetID = f.FleetID
inner join	FCT_ShipCargo as sc on sc.ShipID = s.ShipID
left JOIN
(
	select description, fleetID from FCT_MoveOrders where MoveActionID = 136
) as mo_load on mo_load.FleetID = f.FleetID
WHERE
	mo.MoveActionID = 137
AND
	mo.DestinationItemID <> sc.CargoID
--AND
--	mo.Description like '%Unload Trade Goods - Infrastructure'
order by
	--mo.Description
	mo.DestinationItemID
	,sc.CargoID
)

select * from CTE_Fleets



--check fleet orders. 
--select Description, * from FCT_MoveOrders where FleetID in (707492) order by FleetID, MoveOrder
--select Description, * from FCT_MoveOrders where MoveActionID = 136 and FleetID in (209387,210078,209046,209222,209358,209505,209620,209669,210246) order by FleetID

--select * from FCT_FleetHistory where FleetID in (707492) order by FleetID, GameTime desc

--if fleet has cargo but also has a load order, delete the cargo
-- delete from FCT_ShipCargo where ShipID in (201556)
--	delete from FCT_ShipCargo where ShipID in (select ShipID from FCT_Ship where FleetID in (707492)) -- (select FleetID from CTE_Fleets))

--if fleet has the wrong cargo but does not have a load order, change the cargo
-- update FCT_ShipCargo set CargoID = 16 where ShipID in (98528,98540,98549,98717)




-- update FCT_MoveOrders set DestinationItemID = 6 where FleetID = 209178 and MoveOrder = 5
--select Description, * from FCT_MoveOrders where FleetID in (209181) order by FleetID, MoveOrder
--select * from FCT_FleetHistory where FleetID = 209163 
