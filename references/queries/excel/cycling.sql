--drop view vw_cycling;
--create view vw_cycling as

WITH CTE_ShipClassCargoCapacity as
(
	SELECT
		sc.ShipClassID
		,sum(cc.NumComponent * sdc.ComponentValue) as CargoCapacity
		--,sdc.*
	FROM		
		FCT_ShipClass as sc
	inner JOIN (select RaceID from FCT_Race where RaceID = 262) as CurrentRace on CurrentRace.RaceID = sc.RaceID
	inner JOIN FCT_ClassComponent as cc on	cc.ClassID = sc.ShipClassID
	inner JOIN FCT_ShipDesignComponents as sdc on sdc.SDComponentID = cc.ComponentID AND sdc.ComponentTypeID in (4,17)
	group by sc.ShipClassID		
),

CTE_TankerClassMuleCapacity as 
(
	select
		sc.ShipClassID
		,sc.ClassName
		,sc.FuelCapacity/1000.0/1000 as FuelCapacityML
		,sc.EnginePower
		,sc.FuelEfficiency
		,sc.MinimumFuel/1000.0/1000 as MinimumFuelML
		,sc.MaxSpeed
		,sc.MaxSpeed * 3600 / sc.EnginePower / sc.FuelEfficiency /1000/1000/1000 *1000*1000 as BkmPerML
		, sc.EnginePower * sc.FuelEfficiency / sc.MaxSpeed / 3600 *1000*1000*1000 /1000/1000 as MLPerBkm
		,sc.*
	FROM
	FCT_ShipClass as sc
	inner JOIN (select max(RaceID) as RaceID from FCT_Race where RaceID = 262) as CurrentRace on CurrentRace.RaceID = sc.RaceID
	inner JOIN FCT_HullDescription as hd on hd.HullDescriptionID = sc.HullDescriptionID
	where hd.HullAbbr in ('TK','FTK')
)

SELECT
	flt.FleetType
	,flt.FleetDesignator
	,flt.FleetShipCount
	,flt.FleetName
	--,substr(FleetCapacity.ClassName,1,instr(FleetCapacity.ClassName,' ')-1) as ClassName
	,fleetCapacity.ClassName
	,flt.FleetSourceName
	,flt.FleetDestinationName
	,flt.FleetDestinationSystem
	,flt.FleetDestinationBody	
	,flt.Cargo
	,FleetCapacity.CargoCapacity
	,cast(flt.Rate as float) as Rate
	,FleetCapacity.FuelCapacityML
	,FleetCapacity.MLPerBkm
	,FleetCapacity.MinimumFuelML
	/*
	,flt.RaceID
	,flt.FleetID
	,CASE
		WHEN mo_load.MoveActionID = 4 then 'mpop'
		else pi.Name 
	END as Cargo
	*/
FROM
(
	SELECT
		flt.FleetType
		,flt.FleetDesignator
		,flt.FleetShipCount
		,flt.FleetSourceName
		,flt.FleetDestinationSystem
		,flt.FleetDestinationBody
		,flt.FleetDestinationName
		,substr(flt.FleetNameRem,1,flt.SpaceIndex-1) as Cargo
		,substr(flt.FleetNameRem,flt.SpaceIndex+1,flt.SlashIndex-flt.SpaceIndex-1) as Rate	
		,flt.FleetName
		,flt.RaceID
		,flt.FleetID
		--,flt.*	'confac'
	FROM
	(
		SELECT x.FleetType ,x.FleetDesignator, x.FleetShipCount, FleetSourceName, FleetDestinationSystem, FleetDestinationBody, FleetDestinationSystem || FleetDestinationBody as FleetDestinationName, FleetNameRem
			,instr(x.FleetNameRem,' ') as SpaceIndex
			,instr(x.FleetNameRem,'/') as SlashIndex			
			,flt.*
		from FCT_Fleet as flt inner JOIN
		(
			SELECT x.FleetType ,x.FleetDesignator, x.FleetShipCount, x.FleetSourceName--, x.FleetNameRem
				,substr(x.FleetNameRem,1,3) as FleetDestinationSystem
				,substr(x.FleetNameRem,4,instr(x.FleetNameRem,' ')-4) as FleetDestinationBody
				,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
				,flt.*
			from FCT_Fleet as flt inner JOIN
			(
				SELECT x.FleetType ,x.FleetDesignator, x.FleetShipCount--, x.FleetNameRem
					,substr(x.FleetNameRem,1,instr(x.FleetNameRem,' ')-1) as FleetSourceName
					,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
					,flt.*
				from FCT_Fleet as flt inner JOIN
				(
					SELECT x.FleetType ,x.FleetDesignator
						,substr(x.FleetNameRem, 1, instr(x.FleetNameRem,' ')-1) as FleetShipCount
						,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
						,flt.*
					FROM FCT_Fleet as flt inner JOIN
					(
						select x.FleetType, flt.FleetID
							,substr(x.FleetNameRem, 1, instr(x.FleetNameRem,' ')-1) as FleetDesignator
							,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
							
						from FCT_Fleet as flt inner JOIN
						(
							SELECT
								flt.FleetID
								,substr(flt.FleetName,1,instr(flt.FleetName,' ')-1) as FleetType
								,substr(flt.FleetName,instr(flt.FleetName,' ')+1) as FleetNameRem
							from
								FCT_Fleet as flt
							inner JOIN	(select max(RaceID) as RaceID from FCT_Race where RaceID = 262) as CurrentRace on CurrentRace.RaceID = flt.RaceID
							WHERE
								substr(flt.FleetName,1,instr(flt.FleetName,' ')-1) in ('CS','FT','TK')
							AND
								flt.FleetName like '%/yr%'
							AND
								flt.ShippingLine = 0
						) as x on x.FleetID = flt.FleetID
					) as x on x.FleetID = flt.FleetID
				) as x on x.FleetID = flt.FleetID
			) as x on x.FleetID = flt.FleetID
		) as x on x.FleetID = flt.FleetID					
	) as flt
) as flt
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where RaceID = 262) as CurrentRace
on
	CurrentRace.RaceID = flt.RaceID
left JOIN
	FCT_MoveOrders as mo_load
on
	mo_load.FleetID = flt.FleetID
AND
	mo_load.MoveActionID in (4,176)
left JOIN
	FCT_MoveOrders as mo_unload
on
	mo_unload.FleetID = flt.FleetID
AND
	mo_unload.MoveActionID in (6,96)
left JOIN
	DIM_PlanetaryInstallation as pi
on
	pi.PlanetaryInstallationID = mo_load.DestinationItemID
inner JOIN
(
	SELECT
		s.FleetID
		,substr(sc.ClassName||' ',1,instr(sc.ClassName||' ',' ')-1) || ifnull(scTrailer.ClassName,'') as ClassName
		--,sc.ClassName || ifnull(scTrailer.ClassName,'') as ClassName --,sc.ClassName || ' ' as ClassName
		,sum(ifnull(sCap.CargoCapacity,0) + ifnull(sCapTrailer.CargoCapacity,0)) as CargoCapacity
		,sCapTanker.*
		--,sdc.*
	FROM
		fct_ship as s
	inner JOIN
		(select max(RaceID) as RaceID from FCT_Race where RaceID = 262) as CurrentRace
	on
		CurrentRace.RaceID = s.RaceID
	inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
	left join CTE_ShipClassCargoCapacity as sCap on sCap.ShipClassID = s.ShipClassID
	left join fct_ship as sTrailer on sTrailer.ShipID = s.TractorTargetShipID
	left join FCT_ShipClass as scTrailer on scTrailer.ShipClassID = sTrailer.ShipClassID
	left join CTE_ShipClassCargoCapacity as sCapTrailer on sCapTrailer.ShipClassID = sTrailer.ShipClassID
	
	left join CTE_TankerClassMuleCapacity as sCapTanker on sCapTanker.ShipClassID = s.ShipClassID
	/*inner JOIN
		FCT_ClassComponent as cc
	on
		cc.ClassID = s.ShipClassID
	left JOIN
		FCT_ShipDesignComponents as sdc
	on
		sdc.SDComponentID = cc.ComponentID
	AND
		sdc.ComponentTypeID in (4,17)
	left JOIN
		FCT_ShipClass as scTrailer
	on
		scTrailer.ShipClassID = sTrailer.ShipClassID
	left JOIN
		FCT_ClassComponent as ccTrailer
	on
		ccTrailer.ClassID = sTrailer.ShipClassID
	left JOIN
		FCT_ShipDesignComponents as sdcTrailer
	on
		sdcTrailer.SDComponentID = ccTrailer.ComponentID
	AND
		sdcTrailer.ComponentTypeID in (4,17)
	*/
	WHERE
		sc.MaxSpeed > 1 --to avoid double counting trailers: they only appear in the scTrailer join trail		
	group by
		s.FleetID
		,substr(sc.ClassName,1,instr(sc.ClassName,' ')-1) || ifnull(scTrailer.ClassName,'')
) as FleetCapacity
on
	FleetCapacity.FleetID = flt.FleetID

order by
	flt.FleetName
	
