--SQL BFS

--select * from vw_jumppoints

WITH const AS (SELECT
	 (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID
	,'JP Adcock-Acuna%' as node_start
	,'JP Aaron-Abreu%'  as node_end
),

vw_jumppoints_thisrace as
(
select 
	* 
FROM
	const
inner JOIN
	vw_jumppoints as jp1
on
	jp1.RaceID = const.raceID
),

node_links_view AS
(
SELECT
	
	--row_number() over (partition by 0 order by JP1_ID, JP2_ID) as linkID
	JP1_ID as node_id 
	,JP2_ID as destination_node_id
	,distanceSquared as link_length
FROM
(


--all intra-system JP links
SELECT
	'JP ' || jp1.SystemName || '-' || jp1.DestinationName as JP1_ID 
	,'JP ' || jp2.SystemName || '-' || jp2.DestinationName as JP2_ID 
	,jp1.SystemName
	,(jp1.Xcor-jp2.Xcor)*(jp1.Xcor-jp2.Xcor)+(jp1.Ycor-jp2.Ycor)*(jp1.Ycor-jp2.Ycor) as distanceSquared
	--,*
FROM
	const
inner JOIN
	vw_jumppoints_thisrace as jp1
inner JOIN
	vw_jumppoints_thisrace as jp2
on
	jp2.SystemID = jp1.SystemID
AND
	jp2.WarpPointID <> jp1.WarpPointID
	
	
union ALL

--all intersystem JP links
SELECT
	'JP ' || jp1.SystemName || '-' || jp1.DestinationName as JP1_ID --  jp1.WarpPointID as JP1_ID
	,'JP ' || jp1.DestinationName || '-' || jp1.SystemName as JP2_ID --  jp2.WarpPointID as JP1_ID
	,'-' as SystemName
	,0 as distanceSquared
FROM
	vw_jumppoints_thisrace as jp1

--this join is only to avoid getting the same link from both sides
/*
inner JOIN
	vw_jumppoints as jp2
on
	jp2.RaceID = const.raceID
AND
	jp2.WarpPointID = jp1.WarpPointID_dest
AND
	jp2.WarpPointID > jp1.WarpPointID
FCT_RaceJumpPointSurvey as rjps1
on
	rjps1.RaceID = const.RaceID
AND
	rjps1.Explored = 1
inner JOIN
	FCT_RaceJumpPointSurvey as rjps2
on
	rjps2.RaceID = const.RaceID
AND
	rjps2.WarpPointID = jp1.WPLink
AND
	rjps2.Explored = 1
inner JOIN
	FCT_JumpPoint as jp1
on
	jp1.WarpPointID = rjps1.WarpPointID
inner JOIN
	FCT_JumpPoint as jp2
on
	jp2.WarpPointID = rjps2.WarpPointID
*/
) as x
),

 search_path (path_ids, last_node_id, length, is_visited) AS
(
SELECT
	node_id || ' | ' || destination_node_id as path_ids
	,destination_node_id as last_node_id
	,link_length as length
    ,node_id = destination_node_id as is_visited
FROM
	node_links_view
inner JOIN
	const
on
	node_links_view.node_id like const.node_start

UNION ALL

SELECT
	path_ids || ' | ' || d.destination_node_id
	,d.destination_node_id
	,f.length + d.link_length
	,instr(f.path_ids,d.destination_node_id) > 0
	
FROM
	node_links_view as d
INNER JOIN
	search_path as f
ON
	f.last_node_id = d.node_id
AND
	--NOT f.is_visited
	instr(f.path_ids,d.destination_node_id) = 0
)


SELECT * FROM search_path
inner join const
on 
--	path_ids like node_start --node name of the start node  path_ids[1] = 1
--AND 
	last_node_id like node_end --node name of the last node  path_ids[array_length(path_ids, 1)] = 6

ORDER BY path_ids ;-- length;

	

/*
SELECT
    node_id || ' | ' || destination_node_id as path_ids
    ,link_length                -- length
    node_id = destination_node_id       -- is_visited
FROM
    node_links_view;
*/

--order by
--	SystemName