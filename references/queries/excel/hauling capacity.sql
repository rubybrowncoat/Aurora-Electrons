--drop view vw_haulingCapacity;
--create view vw_haulingCapacity as

WITH const AS (SELECT
	 --'Duffel'
	 --'Slurp'
	 --'HaulerA2' 	 
	 --'Gater'
	 --'Uber'
	-- as designName
	--,
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID
	--,2 as minimumComponentCost
)

,CTE_CurrentShipCounts as
(
	SELECT
		s.ShipClassID, count(*) as CurrentCount
	FROM
		FCT_Ship as s
	inner JOIN const on	const.raceID = s.RaceID
	group by s.ShipClassID
		
)

--select * from CTE_CurrentShipCounts

,CTE_ShipClass_ProperCargo as
(
	SELECT
		sc.ClassName
		,sc.ClassShippingLineID
		,counts.CurrentCount --sc.TotalNumber
		,sc.CargoCapacity
		,sc.ColonistCapacity
		,sc.MaxSpeed
		,sc.MaxSpeed * 60.0*60*24*365/1000/1000/1000 as BkmPerYear
		,sc.FuelEfficiency * sc.EnginePower * 24 * 365/1000/1000 * sc.TotalNumber as MLPerYear		
		--,sc.*
	FROM
		FCT_ShipClass as sc
	inner JOIN
		const 
	on
		const.raceID = sc.RaceID
	inner JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID
	inner join CTE_CurrentShipCounts as counts on counts.ShipClassID = sc.ShipClassID
	WHERE
		(sc.CargoCapacity > 0 or sc.ColonistCapacity > 0)
	AND
		sc.MaxSpeed > 1
	AND
		hd.HullAbbr in ('FT','CS')
	--AND
	--	sc.ClassShippingLineID = 0	
)

,CTE_ShipClass_Trailer as
(
	SELECT
		sc.ClassName
		--,substr(sc.ClassName,1,instr(sc.ClassName,' ')-1) as BaseClassName
		,sc.Size
		,counts.CurrentCount --sc.TotalNumber
		,sc.CargoCapacity
		,sc.ColonistCapacity
		,sc.MaxSpeed
		,hd.HullAbbr
		,sc.ShipClassID
		--,sc.*
	FROM
		FCT_ShipClass as sc
	inner JOIN
		const 
	on
		const.raceID = sc.RaceID
	inner join CTE_CurrentShipCounts as counts on counts.ShipClassID = sc.ShipClassID
	inner JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID

	WHERE
		(sc.CargoCapacity > 0 or sc.ColonistCapacity > 0)
	AND
		sc.MaxSpeed = 1
	AND
		hd.HullAbbr in ('FT','CS')
	AND
		sc.ClassShippingLineID = 0	
)

--select * from CTE_ShipClass_Trailer

,CTE_ShipClass_Tractor as
(
	SELECT
		sc.ClassName
		,CASE when instr(sc.ClassName,' ') = 0 then sc.ClassName else substr(sc.ClassName,1,instr(sc.ClassName,' ')-1) end as BaseClassName
		,sc.Size
		,counts.CurrentCount --sc.TotalNumber
		,sc.CargoCapacity
		,sc.ColonistCapacity
		,sc.MaxSpeed
		,sc.FuelEfficiency * sc.EnginePower * 24 * 365/1000/1000 * counts.CurrentCount as MLPerYear
		,hd.HullAbbr
		,sc.ShipClassID
		,sc.FuelEfficiency,sc.EnginePower,sc.TotalNumber
		--,sc.*
	FROM
		FCT_ShipClass as sc
	inner JOIN
		const 
	on
		const.raceID = sc.RaceID
	inner join CTE_CurrentShipCounts as counts on counts.ShipClassID = sc.ShipClassID
	inner JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID
	WHERE
		(sc.CargoCapacity = 0 and sc.ColonistCapacity = 0)
	AND
		sc.MaxSpeed > 1
	AND
		hd.HullAbbr in ('FT','CS','TG','TGL')
	AND
		sc.ClassShippingLineID = 0	
)

--select * from CTE_ShipClass_Tractor

,CTE_ShipClass_TractorTrailer as
(
	SELECT
		ifnull(tract.BaseClassName,tract.ClassName) || trail.ClassName as ClassName
		,0 as ClassShippingLineID
		,combocounts.CurrentCount
		,trail.CargoCapacity
		,trail.ColonistCapacity
		,tract.MaxSpeed * tract.Size / (tract.Size + trail.Size) as MaxSpeed
		,tract.MaxSpeed * tract.Size / (tract.Size + trail.Size) * 60*60*24*365/1000/1000/1000 as BkmPerYear		
		,tract.MLPerYear * combocounts.CurrentCount / tract.CurrentCount as MLPerYear
		
		--,tract.ClassName
		--,tract.FuelEfficiency , tract.EnginePower --* 24 * 365/1000/1000 
		--,tract.TotalNumber
		--,tract.Size
		--,trail.ClassName
		--,trail.Size
		--,tract.TotalNumber as Tractors
		--,trail.TotalNumber as Trailers
		
	FROM		
	(
		SELECT
			tract.ShipClassID as tractorClassID ,trail.ShipClassID as trailerClassID
			--,trail.ClassName as trailClassName
			,count(*) as CurrentCount
		from
			fct_ship as shp 
		inner JOIN const on const.raceID = shp.RaceID
		inner join CTE_ShipClass_Tractor as tract on tract.ShipClassID = shp.ShipClassID
		inner join fct_ship as shp_trailer on shp_trailer.ShipID = shp.TractorTargetShipID
		inner JOIN CTE_ShipClass_Trailer as trail on trail.ShipClassID = shp_trailer.ShipClassID
		group by tract.ShipClassID,trail.ShipClassID
	) as combocounts
	inner join CTE_ShipClass_Tractor as tract on tract.ShipClassID = combocounts.tractorClassID
	inner join CTE_ShipClass_Trailer as trail on trail.ShipClassID = combocounts.trailerClassID
	
)
--select * from CTE_ShipClass_TractorTrailer


SELECT * FROM 
(
select 
	*
	, sc.CargoCapacity/25000 * sc.BkmPerYear * sc.CurrentCount as CargoHoldBKMPerYear
	, sc.ColonistCapacity * sc.MaxSpeed * 60.0*60*24*365/1000/1000/1000/1000/1000 * sc.CurrentCount as MPopBKMPerYear
from CTE_ShipClass_ProperCargo as sc
union ALL
select
	*
	, sc.CargoCapacity/25000 * sc.BkmPerYear * sc.CurrentCount as CargoHoldBKMPerYear
	, sc.ColonistCapacity * sc.MaxSpeed * 60.0*60*24*365/1000/1000/1000/1000/1000 * sc.CurrentCount as MPopBKMPerYear
from CTE_ShipClass_TractorTrailer as sc
) as x order by x.ClassShippingLineID, x.ClassName
