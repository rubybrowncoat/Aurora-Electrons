--drop view vw_pop; 
--create view vw_pop as 
SELECT
	_pop.PopName
	,popName.BasicPopName
	,_pop.Population
	,ifnull(InboundShipping.PopAmount/1000/1000,0) as Pop
	
	--Inbound Total Amounts
	,ifnull(InboundShipping.MineAmount,0) as Mine
	,ifnull(InboundShipping.INFAmount,0) as INF
	,ifnull(InboundShipping.DSTAmount,0) as DSTinb
	,ifnull(InboundShipping.LGIAmount,0) as LGI
	,ifnull(InboundShipping.ConFacAmount		,0) as ConFac
	,ifnull(InboundShipping.MaintFacAmount,0) as MaintFac
	,ifnull(InboundShipping.FinCenAmount,0) as FinCen
	,ifnull(InboundShipping.LabAmount,0) as Lab
	,ifnull(InboundShipping.TradeGoodsAmount,0) as TG
	,ifnull(InboundShipping.TotalAmount,0.0) - ifnull(InboundShipping.PopAmount,0) - ifnull(InboundShipping.MineAmount,0.0) - ifnull(InboundShipping.INFAmount,0.0)- ifnull(InboundShipping.DSTAmount,0.0) - ifnull(InboundShipping.LGIAmount,0.0) - ifnull(InboundShipping.ConFacAmount,0.0) - ifnull(InboundShipping.MaintFacAmount,0.0) - ifnull(InboundShipping.FinCenAmount,0) - ifnull(InboundShipping.LabAmount,0) - ifnull(InboundShipping.TradeGoodsAmount,0) as Other
	
	--Inbound Cycling Amounts
	,ifnull(InboundCycling.MineAmount,0) as Mine_Cycling
	,ifnull(InboundCycling.INFAmount,0) as INF_Cycling
	,ifnull(InboundCycling.DSTAmount,0) as DST_Cycling
	,ifnull(InboundCycling.LGIAmount,0) as LGI_Cycling
	,ifnull(InboundCycling.ConFacAmount		,0) as ConFac_Cycling
	,ifnull(InboundCycling.MaintFacAmount,0) as MaintFac_Cycling
	,ifnull(InboundCycling.FinCenAmount,0) as FinCen_Cycling
	,ifnull(InboundCycling.LabAmount,0) as Lab_Cycling
	,ifnull(InboundCycling.TotalAmount,0.0) - ifnull(InboundCycling.PopAmount,0) - ifnull(InboundCycling.MineAmount,0.0) - ifnull(InboundCycling.INFAmount,0.0)- ifnull(InboundCycling.DSTAmount,0.0) - ifnull(InboundCycling.LGIAmount,0.0) - ifnull(InboundCycling.ConFacAmount,0.0) - ifnull(InboundCycling.MaintFacAmount,0.0) - ifnull(InboundCycling.FinCenAmount,0) - ifnull(InboundCycling.LabAmount,0) as Other_Cycling
	
	,_pop.ColonistDestination
	,_pop.ReqInf
	,_infr.InfraTOTAL
	,_infr.InfraRegular
	,_infr.InfraLG
	,_infr.WorkersRequired_Infr
	,_yard.WorkersRequired_Yard
	,_infr.Confacs
	,_infr.DST
	,ifnull(ipInfra.Percentage, 0) as InfraPCT
	,ifnull(ipLGI.Percentage, 0) as LGIPCT
	,ifnull(ipCamps.Percentage, 0) as CampsPCT
	
	,gsb.NetBonus_GroundConstruction
	,gsb.NetBonus_Logistics
	,gsb.NetBonus_Mining
	,gsb.NetBonus_PopulationGrowth
	,gsb.NetBonus_Production
	,gsb.NetBonus_Shipbuilding
	,gsb.NetBonus_Terraforming
	,gsb.NetBonus_WealthCreation
	
	--,*
FROM
	FCT_Population as _pop
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = _pop.RaceID
left JOIN vw_popname as popname on popname.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		_pi.PopID
		,sum(case when _pi.PlanetaryInstallationID = 9 then _pi.Amount else 0 end) as InfraRegular
		,sum(case when _pi.PlanetaryInstallationID = 41 then _pi.Amount else 0 end) as InfraLG
		,sum(case when _pi.PlanetaryInstallationID in (9,41) then _pi.Amount else 0 end) as InfraTOTAL
		,sum(case when _pi.PlanetaryInstallationID in (5,47) then _pi.Amount else 0 end) as Confacs
		,sum(case when _pi.PlanetaryInstallationID = 11 then _pi.Amount else 0 end) as DST
		,sum(dpi.Workers * _pi.Amount) as WorkersRequired_Infr
	from
		FCT_PopulationInstallations as _pi
	left JOIN
		DIM_PlanetaryInstallation as dpi on dpi.PlanetaryInstallationID = _pi.PlanetaryInstallationID
	group by 
		_pi.PopID 
) as _infr
on
	_infr.PopID = _pop.PopulationID
left JOIN
(
	SELECT
		yard.PopulationID
		,SUM(yard.Capacity * yard.Slipways * CASE yard.SYType WHEN 1 then 1 ELSE 0.1 END) / 1000 / 4 as WorkersRequired_Yard
	FROM
		FCT_Shipyard as yard
	group by yard.PopulationID
) as _yard
on
	_yard.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		sum(case when sc.CargoTypeID = 1 then sc.Amount else 0 end) as PopAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 7 then sc.Amount else 0 end) as MineAmount
		,sum(case when (sc.CargoTypeID = 2 and sc.CargoID = 9) or (sc.CargoTypeID = 7 and sc.CargoID = 16) then sc.Amount else 0 end) as INFAmount
		,sum(case when (sc.CargoTypeID = 2 and sc.CargoID = 41) or (sc.CargoTypeID = 7 and sc.CargoID = 18) then sc.Amount else 0 end) as LGIAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 11 then sc.Amount else 0 end) as DSTAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 5 then sc.Amount else 0 end) as ConFacAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 21 then sc.Amount else 0 end) as MaintFacAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 25 then sc.Amount else 0 end) as FinCenAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 8 then sc.Amount else 0 end) as LabAmount	
		,sum(case when sc.CargoTypeID = 7 and sc.CargoID  not in (16,18) then sc.Amount else 0 end) as TradeGoodsAmount	
		,sum(sc.Amount) as TotalAmount
		
		,mo.PopulationID
		--,mo.*
	FROM
		fct_fleet as f	
	inner JOIN
		fct_ship as s
	on
		s.FleetID = f.FleetID
	inner JOIN
		FCT_ShipCargo as sc
	on
		sc.ShipID = s.ShipID
	inner JOIN
		FCT_MoveOrders as mo
	on
		mo.FleetID = f.FleetID
--	inner JOIN
--		FCT_Population as p
--	on
--		p.PopulationID = mo.PopulationID
	WHERE
		--f.CivilianFunction = 2
	--AND
		mo.MoveActionID in (6,96,177,137)
	group by
		mo.PopulationID
) as InboundShipping
on
	InboundShipping.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		sum(case when sc.CargoTypeID = 1 then sc.Amount else 0 end) as PopAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 7 then sc.Amount else 0 end) as MineAmount
		,sum(case when (sc.CargoTypeID = 2 and sc.CargoID = 9) or (sc.CargoTypeID = 7 and sc.CargoID = 16) then sc.Amount else 0 end) as INFAmount
		,sum(case when (sc.CargoTypeID = 2 and sc.CargoID = 41) or (sc.CargoTypeID = 7 and sc.CargoID = 18) then sc.Amount else 0 end) as LGIAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 11 then sc.Amount else 0 end) as DSTAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 5 then sc.Amount else 0 end) as ConFacAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 21 then sc.Amount else 0 end) as MaintFacAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 25 then sc.Amount else 0 end) as FinCenAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 8 then sc.Amount else 0 end) as LabAmount	
		,sum(sc.Amount) as TotalAmount
		
		,mo.PopulationID
		--,mo.*
	FROM
		fct_fleet as f	
	inner JOIN
		fct_ship as s
	on
		s.FleetID = f.FleetID
	inner JOIN
		FCT_ShipCargo as sc
	on
		sc.ShipID = s.ShipID
	inner JOIN
		FCT_MoveOrders as mo
	on
		mo.FleetID = f.FleetID
--	inner JOIN
--		FCT_Population as p
--	on
--		p.PopulationID = mo.PopulationID
	WHERE
		--f.CivilianFunction = 2
	--AND
		mo.MoveActionID in (6,96,177)
	AND
		f.FleetName like '% CY%'
	AND
		f.FleetName like '%/yr%'
	group by
		mo.PopulationID
) as InboundCycling
on
	InboundCycling.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description = 'Infrastructure'
group by ip.RaceID, ip.PopulationID
) as ipInfra
on ipInfra.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description = 'Low Gravity Infrastructure'
group by ip.RaceID, ip.PopulationID
) as ipLGI
on ipLGI.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description like 'Forced Labour%'
group by ip.RaceID, ip.PopulationID
) as ipCamps
on ipCamps.PopulationID = _pop.PopulationID
left JOIN
	vw_GovernorSectorBonus as gsb
on
	gsb.PopulationID = _pop.PopulationID
order by
	_pop.Population desc
	