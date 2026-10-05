with params as
(
	SELECT
		'%saa%' as PopName	--leave blank to get inbound shipping for all pops
)

select ics.* from params as p
inner join vw_InboundCargoShips as ics
on ics.BasicPopName like p.PopName
order by
	ics.BasicPopName
	,ics.MoveAction
	,ics.Amount
	--,f.ShippingLine
	--,substr(ifnull(mo_unload.Description,mo_load.Description) ,instr(ifnull(mo_unload.Description,mo_load.Description),': ')+2)
	--,ifnull(mo_unload.Description,mo_load.Description)
	--,ifnull(sc.amount, cl.CargoCapacity/25000)
	--,rss.Name
	--,f.FleetName

--create view vw_InboundCargoShips as
/*
SELECT
	mo_unload.MoveOrderID,
	p.BasicPopName
	,f.FleetName
	,f.Speed
	,rss.Name as FleetSystem
	--,mo_unload.Description
	--,instr(mo_unload.Description,': ')
	,substr(ifnull(mo_unload.Description,mo_load.Description) ,instr(ifnull(mo_unload.Description,mo_load.Description),': ')+2) as MoveAction
	,sc.Amount
	,cl.CargoCapacity -- /25000.0)
	,ifnull(mo_unload.DestinationItemID,mo_load.DestinationItemID) as DestinationItemID
	,ifnull(mo_unload.DestinationItemType,mo_load.DestinationItemType) as DestinationItemType
	,sc.CargoTypeID
	,sc.CargoID
	,cl.ColonistCapacity
	,s.SLRetire
	
	,ifnull(mo_unload.MoveActionID,mo_load.MoveActionID) as MoveActionID
	
	,mo_loadPrior.DestinationItemID
	
	
	,(case when mo_unload.MoveActionID = 6 then ifnull(sc.Amount,cl.ColonistCapacity) else 0 end) / 1000000.0 as PopAmountM
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 7 then ifnull(sc.Amount,cl.CargoCapacity/25000.0) else 0 end) as MineAmount
	,(case when ((mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 9) or (mo_unload.DestinationItemType = 24 and mo_unload.DestinationItemID = 16) then ifnull(sc.Amount,cl.CargoCapacity/2500.0) else 0 end) as INFAmount
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 11 then ifnull(sc.Amount,cl.CargoCapacity/25000.0) else 0 end) as DSTAmount
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 5 then ifnull(sc.Amount,cl.CargoCapacity/25000.0) else 0 end) as ConFacAmount
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 21 then ifnull(sc.Amount,cl.CargoCapacity/25000.0) else 0 end) as MaintFacAmount
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 25 then ifnull(sc.Amount,cl.CargoCapacity/25000.0) else 0 end) as FinCenAmount
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 8 then ifnull(sc.Amount,cl.CargoCapacity/500000.0) else 0 end) as LabAmount
	,(case when (mo_unload.MoveActionID = 96 or mo_unload.DestinationItemType = 19) and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID) = 6 then ifnull(sc.Amount,cl.CargoCapacity/50000.0) else 0 end) as TFIAmount
	,(case when sc.CargoTypeID = 7 and sc.CargoID  not in (16,18) then ifnull(sc.Amount,cl.CargoCapacity/25000.0) else 0 end) as TradeGoodsAmount	--trade goods that aren't INF or LGI (accounted for above)
	,(case when mo_unload.DestinationItemType = 24 and coalesce(sc.CargoID,mo_loadPrior.DestinationItemID,mo_unload.DestinationItemID)  not in (16) then ifnull(sc.Amount,cl.CargoCapacity/2500.0) else 0 end) as TradeGoodsAmount	--trade goods that aren't INF (accounted for above)
	,(
		case 
			when mo_unload.MoveActionID = 6 then 0		-- ignore colonists
			else cl.CargoCapacity/1000
		END
	) as NetCargoAmountKT
	--,mo_unload.PopulationID
	--,mo_unload.*
	
	
	
	
FROM
	params full join vw_const as c
inner JOIN
	vw_popname as p
on
	(params.PopName = '' OR upper(p.BasicPopName) like upper(params.PopName))
inner join
	fct_fleet as f	
on
	f.RaceID = c.RaceID
inner JOIN
	fct_ship as s
on
	s.FleetID = f.FleetID
inner JOIN FCT_ShipClass as cl on cl.ShipClassID = s.ShipClassID
left JOIN
	FCT_ShipCargo as sc
on
	sc.ShipID = s.ShipID
left JOIN
	FCT_MoveOrders as mo_load
on
	mo_load.FleetID = f.FleetID
AND
	mo_load.PopulationID = p.PopulationID
AND
(
	mo_load.MoveActionID = 4	-- load colonists 
	or
	mo_load.MoveActionID = 136	-- Load Trade Goods. Fleets with this order are always civilian, but they don't have cargo yet.
	or
	mo_load.MoveActionID = 176	-- Load Installation.
)
left JOIN
	FCT_MoveOrders as mo_unload
on
	mo_unload.FleetID = f.FleetID
AND
	mo_unload.PopulationID = p.PopulationID
AND
(
	(mo_unload.MoveActionID = 6)-- AND sc.CargoTypeID = 1) --match unload colonists order to colonist cargo
	or
	(
		mo_unload.MoveActionID in (96,177)	-- Unload All Installations, Unload Installation
		or
		(mo_unload.MoveActionID = 137 )--AND mo_unload.DestinationItemID = 16)	-- Unload Trade Goods (Infrastructure)
	)-- AND (mo_unload.DestinationItemID in (16) or sc.CargoTypeID in (2,7))) --match unload (installations or trade goods) with corresponding cargo
)
left JOIN	-- if cargo is empty, let's find out what this ship is going to load first
	FCT_MoveOrders as mo_loadPrior
on
	mo_loadPrior.FleetID = f.FleetID
AND
	mo_loadPrior.MoveOrder < mo_unload.MoveOrder	-- we only want a load order if it happens before the unload order
AND
(
	mo_loadPrior.MoveActionID in (176) -- Load Installation
)
inner join FCT_RaceSysSurvey as rss on rss.SystemID = f.SystemID and rss.RaceID = c.RaceID
WHERE
--	mo.MoveActionID in (6,96,177,137)
--AND
	(cl.CargoCapacity > 0 or cl.ColonistCapacity > 0)
AND
	ifnull(mo_unload.PopulationID,mo_load.PopulationID) is not NULL	--must have found a load or unload
order by
	p.BasicPopName
	--,f.ShippingLine
	,substr(ifnull(mo_unload.Description,mo_load.Description) ,instr(ifnull(mo_unload.Description,mo_load.Description),': ')+2)
	,ifnull(mo_unload.Description,mo_load.Description)
	,ifnull(sc.amount, cl.CargoCapacity/25000)
	,rss.Name
	,f.FleetName
*/